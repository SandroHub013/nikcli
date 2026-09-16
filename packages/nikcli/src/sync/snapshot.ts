/**
 * Cold-start projection cache. Stores a compact JSON of the last
 * projector-applied state per `(projectID, aggregate, aggregateID)`,
 * together with the last sequence number it was derived from. On the
 * next cold start, the reducer loads the snapshot, replays only the
 * events with `seq > lastSeq`, and persists a new snapshot every
 * `SNAPSHOT_INTERVAL` events.
 *
 * Snapshots are a cache, not a source of truth: if the row is missing
 * or corrupt, the reducer falls back to a full replay from `seq=0`.
 */
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@/database/database"
import { syncSnapshot } from "./sync.sql"
import { Log } from "@nikcli-ai/util/log"

const log = Log.create({ service: "sync.snapshot" })

export const SNAPSHOT_INTERVAL = 100

export type SnapshotKey = {
  projectID: string
  aggregate: string
  aggregateID: string
}

export namespace SyncSnapshot {
  type Executor = Database.TxOrDb

  export function load(key: SnapshotKey, executor?: Executor) {
    return Database.query(
      "SyncSnapshot.load",
      (db) => {
        const row = db
          .select()
          .from(syncSnapshot)
          .where(
            and(
              eq(syncSnapshot.projectId, key.projectID),
              eq(syncSnapshot.aggregate, key.aggregate),
              eq(syncSnapshot.aggregateId, key.aggregateID),
            ),
          )
          .get()
        if (!row) return undefined
        try {
          return { lastSeq: row.lastSeq, state: JSON.parse(row.state) as unknown }
        } catch (error) {
          log.warn("snapshot corrupt, will rebuild from scratch", {
            ...key,
            error,
          })
          return undefined
        }
      },
      executor,
    )
  }

  export function save(key: SnapshotKey, lastSeq: number, state: unknown, executor?: Executor) {
    return Database.query(
      "SyncSnapshot.save",
      (db) => {
        const serialized = JSON.stringify(state ?? {})
        const now = Date.now()
        db.insert(syncSnapshot)
          .values({
            projectId: key.projectID,
            aggregate: key.aggregate,
            aggregateId: key.aggregateID,
            lastSeq,
            state: serialized,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [syncSnapshot.projectId, syncSnapshot.aggregate, syncSnapshot.aggregateId],
            set: { lastSeq, state: serialized, updatedAt: now },
          })
          .run()
      },
      executor,
    )
  }

  export function clear(key: SnapshotKey, executor?: Executor) {
    return Database.query(
      "SyncSnapshot.clear",
      (db) => {
        db.delete(syncSnapshot)
          .where(
            and(
              eq(syncSnapshot.projectId, key.projectID),
              eq(syncSnapshot.aggregate, key.aggregate),
              eq(syncSnapshot.aggregateId, key.aggregateID),
            ),
          )
          .run()
      },
      executor,
    )
  }
}
