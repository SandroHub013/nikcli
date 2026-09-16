import { and, asc, eq, ne } from "drizzle-orm"
import { Database } from "@/database/database"
import { sessionEntry } from "./entry.sql"
import { SessionEntry } from "./entry"

/**
 * SQL-backed store for flat v2 entries.
 *
 * Slice 1 of the v2 write path persists these rows from the event payload
 * before the v1 message/part row. Identity is `ref`, not the entry id: a
 * streaming part is re-emitted many times and every emission has to land on
 * the same row.
 */
export namespace SessionEntryRepo {
  type Executor = Database.TxOrDb

  export interface UpsertInput {
    entry: SessionEntry.Entry
    /** Stable identity within the session — the upsert key. */
    ref: string
  }

  export function upsert(input: UpsertInput, executor?: Executor) {
    return Database.query(
      "SessionEntryRepo.upsert",
      (db) => {
        const { entry, ref } = input
        const messageID = entry.messageID ?? ""

        // No read-before-write: entry ids are derived from the v1 id they come
        // from (SessionEntry.idForPart / idForMessage), so re-projecting the same
        // part always produces the same id. That is also what lets the live
        // projection agree with this one without coordinating.
        const stable = entry
        const info = JSON.stringify(stable)

        db.insert(sessionEntry)
          .values({
            id: stable.id,
            sessionId: stable.sessionID,
            messageId: messageID,
            type: stable.type,
            ref,
            info,
            timestamp: stable.timestamp,
          })
          .onConflictDoUpdate({
            target: sessionEntry.id,
            set: { info, type: stable.type, timestamp: stable.timestamp },
          })
          .run()
      },
      executor,
    )
  }

  export function list(sessionID: string, executor?: Executor) {
    return Database.query(
      "SessionEntryRepo.list",
      (db) => {
        const rows = db
          .select({ info: sessionEntry.info })
          .from(sessionEntry)
          .where(eq(sessionEntry.sessionId, sessionID))
          .orderBy(asc(sessionEntry.id))
          .all()
        return rows.map((row) => JSON.parse(row.info) as SessionEntry.Entry)
      },
      executor,
    )
  }

  /** One entry by its stable identity within a session. */
  export function byRef(sessionID: string, ref: string, executor?: Executor) {
    return Database.query(
      "SessionEntryRepo.byRef",
      (db) => {
        const row = db
          .select({ info: sessionEntry.info })
          .from(sessionEntry)
          .where(and(eq(sessionEntry.sessionId, sessionID), eq(sessionEntry.ref, ref)))
          .get()
        return row ? (JSON.parse(row.info) as SessionEntry.Entry) : undefined
      },
      executor,
    )
  }

  export function count(sessionID: string, executor?: Executor) {
    return Database.query(
      "SessionEntryRepo.count",
      (db) => {
        return db.select({ id: sessionEntry.id }).from(sessionEntry).where(eq(sessionEntry.sessionId, sessionID)).all()
          .length
      },
      executor,
    )
  }

  /**
   * How many distinct v1 messages this session's entries cover.
   *
   * Every message projects to at least one entry — a user message to its
   * `user` entry, an assistant message to its `start` — so comparing this
   * with `MessageRepo.countMessages` says whether the projection is complete
   * without materializing either side.
   */
  export function messageCount(sessionID: string, executor?: Executor) {
    return Database.query(
      "SessionEntryRepo.messageCount",
      (db) => {
        return db
          .selectDistinct({ messageId: sessionEntry.messageId })
          .from(sessionEntry)
          .where(and(eq(sessionEntry.sessionId, sessionID), ne(sessionEntry.messageId, "")))
          .all().length
      },
      executor,
    )
  }

  export function removeRef(sessionID: string, ref: string, executor?: Executor) {
    return Database.query(
      "SessionEntryRepo.removeRef",
      (db) => {
        db.delete(sessionEntry)
          .where(and(eq(sessionEntry.sessionId, sessionID), eq(sessionEntry.ref, ref)))
          .run()
      },
      executor,
    )
  }

  export function removeMessage(messageID: string, executor?: Executor) {
    return Database.query(
      "SessionEntryRepo.removeMessage",
      (db) => {
        db.delete(sessionEntry).where(eq(sessionEntry.messageId, messageID)).run()
      },
      executor,
    )
  }

  export function clear(sessionID: string, executor?: Executor) {
    return Database.query(
      "SessionEntryRepo.clear",
      (db) => {
        db.delete(sessionEntry).where(eq(sessionEntry.sessionId, sessionID)).run()
      },
      executor,
    )
  }
}
