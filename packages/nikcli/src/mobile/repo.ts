import { and, desc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@/database/database"
import { routine } from "./routine.sql"
import type { Routine } from "./routine"

/**
 * SQL-backed repository for mobile/CLI routines.
 *
 * Replaces the `["routine", projectID, id]` JSON key tree. Sanitization
 * happens on the way out: a corrupt row is dropped rather than surfaced.
 */
export namespace RoutineRepo {
  type Executor = Database.TxOrDb

  function toRow(projectId: string, record: Routine.Record) {
    return {
      id: record.id,
      projectId,
      paused: record.paused ? 1 : 0,
      data: JSON.stringify(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  function readRecord(data: string): Routine.Record | undefined {
    try {
      const parsed = JSON.parse(data) as Routine.Record
      if (!parsed || typeof parsed.id !== "string" || typeof parsed.name !== "string") return undefined
      if (typeof parsed.projectID !== "string" || typeof parsed.prompt !== "string") return undefined
      if (!Array.isArray(parsed.triggers)) return undefined
      if (typeof parsed.createdAt !== "number" || typeof parsed.updatedAt !== "number") return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  export function get(projectId: string, id: string, executor?: Executor) {
    return Database.query(
      "RoutineRepo.get",
      (db) => {
        const row = db
          .select({ data: routine.data })
          .from(routine)
          .where(and(eq(routine.projectId, projectId), eq(routine.id, id)))
          .get()
        return row ? readRecord(row.data) : undefined
      },
      executor,
    )
  }

  export function upsert(projectId: string, record: Routine.Record, executor?: Executor) {
    return Database.query(
      "RoutineRepo.upsert",
      (db) => {
        const row = toRow(projectId, record)
        db.insert(routine)
          .values(row)
          .onConflictDoUpdate({
            target: [routine.projectId, routine.id],
            set: {
              paused: row.paused,
              data: row.data,
              updatedAt: row.updatedAt,
            },
          })
          .run()
      },
      executor,
    )
  }

  /** Mutate-in-place, matching `Storage.update`. Returns undefined when missing. */
  export function update(
    projectId: string,
    id: string,
    fn: (draft: Routine.Record) => void,
    executor?: Executor,
  ): Effect.Effect<Routine.Record | undefined, Database.QueryError> {
    return Effect.gen(function* () {
      const current = yield* get(projectId, id, executor)
      if (!current) return undefined
      const draft = structuredClone(current)
      fn(draft)
      yield* upsert(projectId, draft, executor)
      return draft
    })
  }

  /** Newest first, matching the previous JSON-list sort. */
  export function list(projectId: string, executor?: Executor) {
    return Database.query(
      "RoutineRepo.list",
      (db) => {
        const rows = db
          .select({ data: routine.data })
          .from(routine)
          .where(eq(routine.projectId, projectId))
          .orderBy(desc(routine.createdAt))
          .all()
        return rows.flatMap((row) => {
          const record = readRecord(row.data)
          return record ? [record] : []
        })
      },
      executor,
    )
  }

  export function remove(projectId: string, id: string, executor?: Executor) {
    return Database.query(
      "RoutineRepo.remove",
      (db) => {
        const result = db
          .delete(routine)
          .where(and(eq(routine.projectId, projectId), eq(routine.id, id)))
          .run()
        return (result as { changes: number }).changes > 0
      },
      executor,
    )
  }
}
