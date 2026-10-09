import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

// ============================================================================
// Shares — SQL backend for ["session_share", sessionID] + ["local_share", id]
//
// Sharing is gone (it published sessions on Nik's share service). The tables
// stay so existing databases and their migration keep their shape; nothing
// reads or writes them any more.
// ============================================================================

/**
 * The share handle attached to a session (remote secret or local fallback).
 *
 * Keyed by `session_id` because that is how every caller looks it up.
 * `data` is the whole `Session.ShareInfo`.
 */
export const sessionShare = sqliteTable("session_share", {
  sessionId: text("session_id").primaryKey(),
  mode: text("mode"),
  data: text("data").notNull(),
})

/**
 * The local-mode payload that was served at `/share/:id` when the remote hub was down.
 *
 * Keyed by share id (the public identifier), not session id. `items` lives
 * inside `data` because nothing queries it independently.
 */
export const localShare = sqliteTable(
  "local_share",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    data: text("data").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    sessionIdx: index("idx_local_share_session").on(table.sessionId),
  }),
)
