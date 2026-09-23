import { eq } from "drizzle-orm"
import { Database } from "@/database/database"
import { permissionRuleset } from "./permission.sql"
import type { PermissionNext } from "./next"

/**
 * SQL-backed repository for Permission data.
 *
 * Every operation is an Effect whose failure is `Database.QueryError`; the
 * queries underneath stay synchronous. A corrupt `rules` blob reads as an
 * empty ruleset rather than failing, matching the JSON store it replaced.
 */
export namespace PermissionRepo {
  export function get(projectId: string, executor?: Database.TxOrDb) {
    return Database.query(
      "PermissionRepo.get",
      (db) => {
        const row = db.select().from(permissionRuleset).where(eq(permissionRuleset.projectId, projectId)).get()
        if (!row) return [] as PermissionNext.Ruleset
        try {
          return JSON.parse(row.rules) as PermissionNext.Ruleset
        } catch {
          return [] as PermissionNext.Ruleset
        }
      },
      executor,
    )
  }

  export function upsert(projectId: string, rules: PermissionNext.Ruleset, executor?: Database.TxOrDb) {
    return Database.query(
      "PermissionRepo.upsert",
      (db) => {
        db.insert(permissionRuleset)
          .values({
            projectId,
            rules: JSON.stringify(rules),
          })
          .onConflictDoUpdate({
            target: permissionRuleset.projectId,
            set: {
              rules: JSON.stringify(rules),
            },
          })
          .run()
      },
      executor,
    )
  }

  export function remove(projectId: string, executor?: Database.TxOrDb) {
    return Database.query(
      "PermissionRepo.remove",
      (db) => {
        const result = db.delete(permissionRuleset).where(eq(permissionRuleset.projectId, projectId)).run()
        return (result as { changes: number }).changes > 0
      },
      executor,
    )
  }
}
