import { eq } from "drizzle-orm"
import { Database } from "@/database/database"
import { workspace } from "./workspace.sql"
import type { Config } from "./config"

/** Drizzle's .run() returns void in types but actually returns {changes, lastInsertRowid} at runtime */
type RunResult = { changes: number; lastInsertRowid: number | bigint }
function getChanges(result: void | RunResult): number {
  return (result as RunResult).changes
}

export namespace WorkspaceDB {
  type Executor = Database.TxOrDb

  export type Row = {
    id: string
    project_id: string
    name: string
    branch: string | null
    config: Config
    status?: string
    time_used: number
    created_at: number
    updated_at: number
  }

  export type Info = {
    id: string
    projectID: string
    name: string
    timeUsed: number
    branch: string | null
    config: Config
  }

  // ============================================================================
  // Internal helpers
  // ============================================================================

  /** Convert a Drizzle row to the legacy Info type */
  function toInfo(row: typeof workspace.$inferSelect): Info {
    return {
      id: row.id,
      projectID: row.projectId,
      name: row.name ?? "",
      timeUsed: row.timeUsed,
      branch: row.branch,
      config: JSON.parse(row.config) as Config,
    }
  }

  // ============================================================================
  // CRUD operations
  // ============================================================================

  export function get(id: string, executor?: Executor) {
    return Database.query(
      "WorkspaceDB.get",
      (db) => {
        const row = db.select().from(workspace).where(eq(workspace.id, id)).get()
        return row ? toInfo(row) : undefined
      },
      executor,
    )
  }

  export function list(projectID?: string, executor?: Executor) {
    return Database.query(
      "WorkspaceDB.list",
      (db) => {
        const query = db.select().from(workspace).orderBy(workspace.id)
        const rows = projectID ? query.where(eq(workspace.projectId, projectID)).all() : query.all()
        return rows.map(toInfo)
      },
      executor,
    )
  }

  export function getStatus(id: string, executor?: Executor) {
    return Database.query(
      "WorkspaceDB.getStatus",
      (db) => {
        const row = db.select({ status: workspace.status }).from(workspace).where(eq(workspace.id, id)).get()
        return row?.status ?? undefined
      },
      executor,
    )
  }

  /**
   * Update the connection status column only. Phase 0 split this from
   * the old `updateState` because state.events and state.eventLimit are
   * gone — events live in `sync_event`, the limit in `sync_snapshot`.
   */
  export function setStatusColumn(id: string, status: string, executor?: Executor) {
    return Database.query(
      "WorkspaceDB.setStatusColumn",
      (db) => {
        db.update(workspace).set({ status, updatedAt: Date.now() }).where(eq(workspace.id, id)).run()
      },
      executor,
    )
  }

  /**
   * Insert or update a workspace using UPSERT.
   * Replaces the old read-then-write pattern with a single atomic operation.
   */
  export function upsert(info: Info, executor?: Executor) {
    return Database.query(
      "WorkspaceDB.upsert",
      (db) => {
        const now = Date.now()
        db.insert(workspace)
          .values({
            id: info.id,
            projectId: info.projectID,
            name: info.name ?? "",
            branch: info.branch,
            config: JSON.stringify(info.config),
            timeUsed: info.timeUsed ?? now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: workspace.id,
            set: {
              projectId: info.projectID,
              name: info.name ?? "",
              branch: info.branch,
              config: JSON.stringify(info.config),
              timeUsed: info.timeUsed ?? now,
              updatedAt: now,
            },
          })
          .run()
        return info
      },
      executor,
    )
  }

  export function touch(id: string, timeUsed = Date.now(), executor?: Executor) {
    return Database.query(
      "WorkspaceDB.touch",
      (db) => {
        const result = db.update(workspace).set({ timeUsed }).where(eq(workspace.id, id)).run()
        return getChanges(result) > 0
      },
      executor,
    )
  }

  export function remove(id: string, executor?: Executor) {
    return Database.query(
      "WorkspaceDB.remove",
      (db) => {
        const result = db.delete(workspace).where(eq(workspace.id, id)).run()
        return getChanges(result) > 0
      },
      executor,
    )
  }
}
