import { eq } from "drizzle-orm"
import { Database } from "@/database/database"
import type { Session } from "@/session"
import { localShare, sessionShare } from "./share.sql"

/**
 * SQL-backed repository for share handles.
 *
 * Replaces `["session_share", sessionID]` and `["local_share", shareID]`.
 */
export namespace ShareRepo {
  type Executor = Database.TxOrDb

  export type LocalShare = {
    id: string
    sessionID: string
    url: string
    time: {
      created: number
      updated: number
    }
    items: Record<string, unknown>
  }

  function readShare(data: string): Session.ShareInfo | undefined {
    try {
      return JSON.parse(data) as Session.ShareInfo
    } catch {
      return undefined
    }
  }

  function readLocal(data: string): LocalShare | undefined {
    try {
      return JSON.parse(data) as LocalShare
    } catch {
      return undefined
    }
  }

  export function get(sessionId: string, executor?: Executor) {
    return Database.query(
      "ShareRepo.get",
      (db) => {
        const row = db
          .select({ data: sessionShare.data })
          .from(sessionShare)
          .where(eq(sessionShare.sessionId, sessionId))
          .get()
        return row ? readShare(row.data) : undefined
      },
      executor,
    )
  }

  export function put(sessionId: string, share: Session.ShareInfo, executor?: Executor) {
    return Database.query(
      "ShareRepo.put",
      (db) =>
        db
          .insert(sessionShare)
          .values({
            sessionId,
            mode: share.mode ?? null,
            data: JSON.stringify(share),
          })
          .onConflictDoUpdate({
            target: sessionShare.sessionId,
            set: {
              mode: share.mode ?? null,
              data: JSON.stringify(share),
            },
          })
          .run(),
      executor,
    )
  }

  export function remove(sessionId: string, executor?: Executor) {
    return Database.query(
      "ShareRepo.remove",
      (db) => void db.delete(sessionShare).where(eq(sessionShare.sessionId, sessionId)).run(),
      executor,
    )
  }

  export function getLocal(shareId: string, executor?: Executor) {
    return Database.query(
      "ShareRepo.getLocal",
      (db) => {
        const row = db.select({ data: localShare.data }).from(localShare).where(eq(localShare.id, shareId)).get()
        return row ? readLocal(row.data) : undefined
      },
      executor,
    )
  }

  export function putLocal(share: LocalShare, executor?: Executor) {
    return Database.query(
      "ShareRepo.putLocal",
      (db) =>
        db
          .insert(localShare)
          .values({
            id: share.id,
            sessionId: share.sessionID,
            data: JSON.stringify(share),
            createdAt: share.time.created,
            updatedAt: share.time.updated,
          })
          .onConflictDoUpdate({
            target: localShare.id,
            set: {
              sessionId: share.sessionID,
              data: JSON.stringify(share),
              updatedAt: share.time.updated,
            },
          })
          .run(),
      executor,
    )
  }

  export function removeLocal(shareId: string, executor?: Executor) {
    return Database.query(
      "ShareRepo.removeLocal",
      (db) => void db.delete(localShare).where(eq(localShare.id, shareId)).run(),
      executor,
    )
  }
}
