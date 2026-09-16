import { eq } from "drizzle-orm"
import { Database } from "@/database/database"
import { sessionDiff } from "./diff.sql"
import type { Snapshot } from "@/snapshot"

/**
 * SQL-backed repository for the session-level file diff list.
 *
 * Replaces the `["session_diff", sessionID]` JSON key. A missing or corrupt
 * row is an empty list, matching `SessionSummary.diff` on a cache miss.
 *
 * Every operation is an Effect whose failure is `Database.QueryError`; the
 * queries underneath stay synchronous.
 */
export namespace SessionDiffRepo {
  function readDiffs(data: string): Snapshot.FileDiff[] {
    try {
      const parsed = JSON.parse(data)
      return Array.isArray(parsed) ? (parsed as Snapshot.FileDiff[]) : []
    } catch {
      return []
    }
  }

  export function get(sessionId: string, executor?: Database.TxOrDb) {
    return Database.query(
      "SessionDiffRepo.get",
      (db) => {
        const row = db
          .select({ data: sessionDiff.data })
          .from(sessionDiff)
          .where(eq(sessionDiff.sessionId, sessionId))
          .get()
        return row ? readDiffs(row.data) : []
      },
      executor,
    )
  }

  export function upsert(sessionId: string, diffs: Snapshot.FileDiff[], executor?: Database.TxOrDb) {
    return Database.query(
      "SessionDiffRepo.upsert",
      (db) => {
        const now = Date.now()
        db.insert(sessionDiff)
          .values({
            sessionId,
            data: JSON.stringify(diffs),
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: sessionDiff.sessionId,
            set: {
              data: JSON.stringify(diffs),
              updatedAt: now,
            },
          })
          .run()
      },
      executor,
    )
  }

  export function remove(sessionId: string, executor?: Database.TxOrDb) {
    return Database.query(
      "SessionDiffRepo.remove",
      (db) => {
        const result = db.delete(sessionDiff).where(eq(sessionDiff.sessionId, sessionId)).run()
        return (result as { changes: number }).changes > 0
      },
      executor,
    )
  }
}
