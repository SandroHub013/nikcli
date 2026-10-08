import { eq, asc, count } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@/database/database"
import { messageInfo, messagePart } from "./message.sql"
import type { MessageV2 } from "./message-v2"

/**
 * SQL-backed repository for Message and Part data.
 * Provides synchronous CRUD operations against the central nikcli.db.
 */
export namespace MessageRepo {
  /**
   * Writes accept an executor so a projector can run inside the same
   * transaction that appends its event (see sync/sync-event.ts). Reads stay
   * on the shared client — they are never part of a projection.
   */
  type Executor = Database.TxOrDb

  // ============================================================================
  // Message operations
  // ============================================================================

  export function getMessage(sessionId: string, messageId: string, executor?: Executor) {
    return Database.query(
      "MessageRepo.getMessage",
      (db) => {
        const row = db.select().from(messageInfo).where(eq(messageInfo.id, messageId)).get()
        if (!row) return undefined
        return JSON.parse(row.info) as MessageV2.Info
      },
      executor,
    )
  }

  export function listMessages(sessionId: string, executor?: Executor) {
    return Database.query(
      "MessageRepo.listMessages",
      (db) => {
        const rows = db
          .select()
          .from(messageInfo)
          .where(eq(messageInfo.sessionId, sessionId))
          .orderBy(asc(messageInfo.createdAt))
          .all()
        return rows.map((row) => JSON.parse(row.info) as MessageV2.Info)
      },
      executor,
    )
  }

  /**
   * How many messages a session has, without deserializing any of them.
   *
   * Used to check that the v2 entry projection still covers every message
   * (session/v2/index.ts) — a count is enough because every message projects
   * to at least one entry.
   *
   * `SELECT COUNT(*)` instead of `SELECT id … array.length` so the database
   * never streams full row data for a query whose only product is a number.
   */
  export function countMessages(sessionId: string, executor?: Executor) {
    return Database.query(
      "MessageRepo.countMessages",
      (db) => {
        return db.select({ c: count() }).from(messageInfo).where(eq(messageInfo.sessionId, sessionId)).get()?.c ?? 0
      },
      executor,
    )
  }

  export function upsertMessage(msg: MessageV2.Info, executor?: Executor) {
    return Database.query(
      "MessageRepo.upsertMessage",
      (db) => {
        db.insert(messageInfo)
          .values({
            id: msg.id,
            sessionId: msg.sessionID,
            role: msg.role,
            info: JSON.stringify(msg),
            createdAt: msg.time.created,
          })
          .onConflictDoUpdate({
            target: messageInfo.id,
            set: {
              info: JSON.stringify(msg),
            },
          })
          .run()
      },
      executor,
    )
  }

  export function removeMessage(sessionId: string, messageId: string, executor?: Executor) {
    return Database.query(
      "MessageRepo.removeMessage",
      (db) => {
        // Remove associated parts first
        db.delete(messagePart).where(eq(messagePart.messageId, messageId)).run()
        const result = db.delete(messageInfo).where(eq(messageInfo.id, messageId)).run()
        return (result as { changes: number }).changes > 0
      },
      executor,
    )
  }

  // ============================================================================
  // Part operations
  // ============================================================================

  export function getPart(messageId: string, partId: string, executor?: Executor) {
    return Database.query(
      "MessageRepo.getPart",
      (db) => {
        const row = db.select().from(messagePart).where(eq(messagePart.id, partId)).get()
        if (!row) return undefined
        return JSON.parse(row.info) as MessageV2.Part
      },
      executor,
    )
  }

  export function listParts(messageId: string, executor?: Executor) {
    return Database.query(
      "MessageRepo.listParts",
      (db) => {
        const rows = db
          .select()
          .from(messagePart)
          .where(eq(messagePart.messageId, messageId))
          .orderBy(asc(messagePart.sortKey))
          .all()
        return rows.map((row) => JSON.parse(row.info) as MessageV2.Part)
      },
      executor,
    )
  }

  export function upsertPart(part: MessageV2.Part, executor?: Executor) {
    return Database.query(
      "MessageRepo.upsertPart",
      (db) => {
        db.insert(messagePart)
          .values({
            id: part.id,
            messageId: part.messageID,
            sessionId: part.sessionID,
            type: part.type,
            info: JSON.stringify(part),
            sortKey: part.id,
          })
          .onConflictDoUpdate({
            target: messagePart.id,
            set: {
              type: part.type,
              info: JSON.stringify(part),
            },
          })
          .run()
      },
      executor,
    )
  }

  export function removePart(messageId: string, partId: string, executor?: Executor) {
    return Database.query(
      "MessageRepo.removePart",
      (db) => {
        const result = db.delete(messagePart).where(eq(messagePart.id, partId)).run()
        return (result as { changes: number }).changes > 0
      },
      executor,
    )
  }

  // ============================================================================
  // Composite operations
  // ============================================================================

  export function getMessageWithParts(sessionId: string, messageId: string, executor?: Executor) {
    return Effect.gen(function* () {
      const info = yield* getMessage(sessionId, messageId, executor)
      if (!info) return undefined
      const parts = yield* listParts(messageId, executor)
      return { info, parts }
    })
  }

  export function getPromptData(sessionId: string, messageId: string, executor?: Executor) {
    return Database.query(
      "MessageRepo.getPromptData",
      (db) => {
        return (
          db.select({ promptData: messageInfo.promptData }).from(messageInfo).where(eq(messageInfo.id, messageId)).get()
            ?.promptData ?? undefined
        )
      },
      executor,
    )
  }

  export function setPromptData(messageId: string, promptData: string, executor?: Executor) {
    return Database.query(
      "MessageRepo.setPromptData",
      (db) => {
        db.update(messageInfo).set({ promptData }).where(eq(messageInfo.id, messageId)).run()
      },
      executor,
    )
  }
}
