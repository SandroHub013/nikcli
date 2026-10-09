import { describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { removeTestDir } from "../helpers/fs"
import { withIsolatedDatabase } from "../helpers/sqlite"

/*
 * Brief ragu-via-servizi-nik, package B, review M2: unsharing used to delete a session's rows in `session_share` and
 * `local_share` when the session was deleted. Sharing is gone, the tables stay, and `local_share.data` holds a whole
 * copy of the session (messages and parts): deleting the session must delete them too, or the copy stays forever.
 * Another session's rows are left alone.
 */
describe.serial("a deleted session leaves no share rows", () => {
  it("deletes the session's session_share and local_share rows, and only those", async () => {
    await withIsolatedDatabase(async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-share-rows-"))
      const [{ Instance }, { Session }, effect, { Database }] = await Promise.all([
        import("@/project/instance"),
        import("@/session"),
        import("@/effect"),
        import("@/database/database"),
      ])
      const db = () => Database.syncNative()
      const count = (table: string, sessionID: string) =>
        (db().query(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionID) as { n: number }).n
      const putRows = (sessionID: string) => {
        db().run("INSERT INTO session_share (session_id, mode, data) VALUES (?, ?, ?)", [
          sessionID,
          "local",
          JSON.stringify({ id: `shr_${sessionID}`, url: "http://127.0.0.1:4096/share/x" }),
        ])
        db().run("INSERT INTO local_share (id, session_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
          `shr_${sessionID}`,
          sessionID,
          JSON.stringify({ items: { message: "the whole transcript" } }),
          1,
          1,
        ])
      }

      try {
        await Instance.provide({
          directory,
          fn: async () => {
            const run = <A, E>(value: Effect.Effect<A, E, any>) =>
              effect.runPromiseWithLayer(Session.defaultLayer, effect.withCurrentInstance(value))
            const create = (title: string) =>
              run(
                Effect.gen(function* () {
                  return yield* (yield* Session.Service).createNext({ directory, title })
                }),
              )
            const gone = await create("deleted")
            const kept = await create("kept")
            putRows(gone.id)
            putRows(kept.id)

            await run(
              Effect.gen(function* () {
                yield* (yield* Session.Service).remove(gone.id)
              }),
            )

            expect([count("session_share", gone.id), count("local_share", gone.id)]).toEqual([0, 0])
            expect([count("session_share", kept.id), count("local_share", kept.id)]).toEqual([1, 1])
          },
        })
      } finally {
        await Instance.disposeAll().catch(() => undefined)
        await removeTestDir(directory)
      }
    })
  })
})
