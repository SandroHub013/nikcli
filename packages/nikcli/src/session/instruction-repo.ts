import { and, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@/database/database"
import { syncSequence } from "@/sync/sync.sql"
import { instructionBlob, instructionState } from "./instruction.sql"

export namespace InstructionRepo {
  type Executor = Database.TxOrDb

  export type Fold = {
    values: Record<string, string>
    order: string[]
    epoch_values: Record<string, string>
    epoch_order: string[]
  }

  export type State = {
    sessionID: string
    epochSeq: number
    updatedSeq: number
    parentSessionID?: string
    parentSeq?: number
    data: Fold
  }

  function parseFold(raw: string): Fold | undefined {
    try {
      const parsed = JSON.parse(raw) as Fold
      if (!parsed || typeof parsed !== "object") return undefined
      if (!parsed.values || typeof parsed.values !== "object") return undefined
      if (!Array.isArray(parsed.order)) return undefined
      if (!parsed.epoch_values || typeof parsed.epoch_values !== "object") return undefined
      if (!Array.isArray(parsed.epoch_order)) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  export function get(sessionID: string, executor?: Executor) {
    return Database.query(
      "InstructionRepo.get",
      (db) => {
        const row = db.select().from(instructionState).where(eq(instructionState.sessionId, sessionID)).get()
        if (!row) return undefined
        const data = parseFold(row.data)
        if (!data) return undefined
        return {
          sessionID: row.sessionId,
          epochSeq: row.epochSeq,
          updatedSeq: row.updatedSeq,
          parentSessionID: row.parentSessionId ?? undefined,
          parentSeq: row.parentSeq ?? undefined,
          data,
        }
      },
      executor,
    )
  }

  export function put(state: State, executor?: Executor) {
    return Database.query(
      "InstructionRepo.put",
      (db) => {
        db.insert(instructionState)
          .values({
            sessionId: state.sessionID,
            epochSeq: state.epochSeq,
            updatedSeq: state.updatedSeq,
            parentSessionId: state.parentSessionID ?? null,
            parentSeq: state.parentSeq ?? null,
            data: JSON.stringify(state.data),
          })
          .onConflictDoUpdate({
            target: instructionState.sessionId,
            set: {
              epochSeq: state.epochSeq,
              updatedSeq: state.updatedSeq,
              parentSessionId: state.parentSessionID ?? null,
              parentSeq: state.parentSeq ?? null,
              data: JSON.stringify(state.data),
            },
          })
          .run()
      },
      executor,
    )
  }

  export function removeSession(sessionID: string, executor?: Executor) {
    return Database.query(
      "InstructionRepo.removeSession",
      (db) => {
        const result = db.delete(instructionState).where(eq(instructionState.sessionId, sessionID)).run()
        return (result as unknown as { changes: number }).changes > 0
      },
      executor,
    )
  }

  export function putBlobs(blobs: Array<{ hash: string; body: string }>, executor?: Executor) {
    return Database.query(
      "InstructionRepo.putBlobs",
      (db) => {
        if (blobs.length === 0) return
        const unique = new Map<string, string>()
        for (const blob of blobs) unique.set(blob.hash, blob.body)
        db.insert(instructionBlob)
          .values([...unique.entries()].map(([hash, body]) => ({ hash, body })))
          .onConflictDoNothing()
          .run()
      },
      executor,
    )
  }

  export function getBlobs(hashes: string[], executor?: Executor) {
    return Database.query(
      "InstructionRepo.getBlobs",
      (db) => {
        if (hashes.length === 0) return {}
        const rows = db.select().from(instructionBlob).where(inArray(instructionBlob.hash, hashes)).all()
        const out: Record<string, string> = {}
        for (const row of rows) out[row.hash] = row.body
        return out
      },
      executor,
    )
  }

  export function getBlob(hash: string, executor?: Executor) {
    return Database.query(
      "InstructionRepo.getBlob",
      (db) => {
        const row = db.select().from(instructionBlob).where(eq(instructionBlob.hash, hash)).get()
        return row?.body
      },
      executor,
    )
  }

  export function applyDelta(
    input: {
      sessionID: string
      delta: Record<string, string>
      seq: number
    },
    executor?: Executor,
  ) {
    return Effect.gen(function* () {
      const current = yield* get(input.sessionID, executor)
      const values = { ...current?.data.values }
      const order = current?.data.order ? [...current.data.order] : []

      for (const [key, value] of Object.entries(input.delta)) {
        if (value === "removed") {
          delete values[key]
          const index = order.indexOf(key)
          if (index >= 0) order.splice(index, 1)
          continue
        }
        if (!(key in (current?.data.values ?? {}))) order.push(key)
        values[key] = value
      }

      const initial = !current
      const data: Fold = initial
        ? { values, order, epoch_values: { ...values }, epoch_order: [...order] }
        : {
            values,
            order,
            epoch_values: current.data.epoch_values,
            epoch_order: current.data.epoch_order,
          }

      const next: State = {
        sessionID: input.sessionID,
        epochSeq: initial ? input.seq : current.epochSeq,
        updatedSeq: input.seq,
        parentSessionID: current?.parentSessionID,
        parentSeq: current?.parentSeq,
        data,
      }
      yield* put(next, executor)
      return next
    })
  }

  export function inherit(parentID: string, childID: string, executor?: Executor) {
    return Effect.gen(function* () {
      const parent = yield* get(parentID, executor)
      if (!parent) return undefined
      const child: State = {
        sessionID: childID,
        epochSeq: 0,
        updatedSeq: 0,
        parentSessionID: parentID,
        parentSeq: parent.updatedSeq,
        data: {
          values: { ...parent.data.values },
          order: [...parent.data.order],
          epoch_values: { ...parent.data.values },
          epoch_order: [...parent.data.order],
        },
      }
      yield* put(child, executor)
      return child
    })
  }

  export function advanceEpoch(sessionID: string, seq: number, executor?: Executor) {
    return Effect.gen(function* () {
      const current = yield* get(sessionID, executor)
      if (!current) return undefined
      const next: State = {
        ...current,
        epochSeq: seq,
        data: {
          ...current.data,
          epoch_values: { ...current.data.values },
          epoch_order: [...current.data.order],
        },
      }
      yield* put(next, executor)
      return next
    })
  }

  export function latestAggregateSeq(projectID: string, sessionID: string, executor?: Executor) {
    return Database.query(
      "InstructionRepo.latestAggregateSeq",
      (db) => {
        const row = db
          .select({ seq: syncSequence.seq })
          .from(syncSequence)
          .where(and(eq(syncSequence.projectId, projectID), eq(syncSequence.aggregate, sessionID)))
          .get()
        return row?.seq ?? 0
      },
      executor,
    )
  }
}
