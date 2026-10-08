import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@/database/database"
import { sessionGoal } from "./goal.sql"
import type { SessionGoal } from "./goal"

/**
 * SQL-backed repository for session goals.
 *
 * Replaces the `["goal", sessionID]` JSON key. Sanitization happens on the
 * way out: a corrupt row is dropped rather than surfaced.
 *
 * Every read and write is an Effect whose failure is `Database.QueryError`, so
 * a caller sees in the signature that talking to the database can fail. The
 * queries underneath stay synchronous — see `Database.query`.
 */
export namespace GoalRepo {
  function readState(data: string): SessionGoal.State | undefined {
    try {
      const parsed = JSON.parse(data) as SessionGoal.State
      if (!parsed || typeof parsed.sessionID !== "string" || typeof parsed.goalID !== "string") return undefined
      if (typeof parsed.objective !== "string" || typeof parsed.status !== "string") return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  export function get(sessionId: string, executor?: Database.TxOrDb) {
    return Database.query(
      "GoalRepo.get",
      (db) => {
        const row = db
          .select({ data: sessionGoal.data })
          .from(sessionGoal)
          .where(eq(sessionGoal.sessionId, sessionId))
          .get()
        return row ? readState(row.data) : undefined
      },
      executor,
    )
  }

  export function upsert(state: SessionGoal.State, executor?: Database.TxOrDb) {
    return Database.query(
      "GoalRepo.upsert",
      (db) => {
        db.insert(sessionGoal)
          .values({
            sessionId: state.sessionID,
            data: JSON.stringify(state),
            updatedAt: state.timeUpdated,
          })
          .onConflictDoUpdate({
            target: sessionGoal.sessionId,
            set: {
              data: JSON.stringify(state),
              updatedAt: state.timeUpdated,
            },
          })
          .run()
      },
      executor,
    )
  }

  /** Mutate-in-place, matching `Storage.update`. Yields undefined when missing. */
  export function update(
    sessionId: string,
    fn: (draft: SessionGoal.State) => void,
    executor?: Database.TxOrDb,
  ): Effect.Effect<SessionGoal.State | undefined, Database.QueryError> {
    return Effect.gen(function* () {
      const current = yield* get(sessionId, executor)
      if (!current) return undefined
      const draft = structuredClone(current)
      fn(draft)
      yield* upsert(draft, executor)
      return draft
    })
  }

  export function remove(sessionId: string, executor?: Database.TxOrDb) {
    return Database.query(
      "GoalRepo.remove",
      (db) => {
        const result = db.delete(sessionGoal).where(eq(sessionGoal.sessionId, sessionId)).run()
        return (result as { changes: number }).changes > 0
      },
      executor,
    )
  }
}
