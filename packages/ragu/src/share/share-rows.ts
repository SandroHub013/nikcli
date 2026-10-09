import { eq } from "drizzle-orm"
import { Database } from "@/database/database"
import { localShare, sessionShare } from "./share.sql"

/**
 * What is left of sharing: the rows old versions wrote. Nothing writes them any
 * more, but `local_share.data` holds a whole copy of the session, so deleting a
 * session deletes its rows too, as unsharing it used to.
 */
export namespace ShareRows {
  export function removeForSession(sessionId: string, executor?: Database.TxOrDb) {
    return Database.query(
      "ShareRows.removeForSession",
      (db) => {
        db.delete(sessionShare).where(eq(sessionShare.sessionId, sessionId)).run()
        db.delete(localShare).where(eq(localShare.sessionId, sessionId)).run()
      },
      executor,
    )
  }
}
