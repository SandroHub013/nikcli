import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@/database/database"
import { account, config } from "./account.sql"
import type { AccountRow, ConfigRow } from "./schema"

type RunResult = { changes: number; lastInsertRowid: number | bigint }
function getChanges(result: void | RunResult): number {
  // SAFETY: drizzle types `.run()` as returning void, but bun:sqlite always
  // returns `{ changes, lastInsertRowid }` at runtime. Callers only pass the
  // result of a `.run()` on this driver, so the void half is a typing artefact.
  return (result as RunResult).changes
}

export namespace AccountDB {
  type Executor = Database.TxOrDb

  // ============================================================================
  // Config cache — avoids repeated reads of the singleton config row
  // ============================================================================

  let _configCache: { row: ConfigRow; cachedAt: number } | undefined
  const CONFIG_CACHE_TTL = 5_000 // 5 seconds

  function getConfigCached(executor?: Executor) {
    return Effect.gen(function* () {
      const now = Date.now()
      if (_configCache && now - _configCache.cachedAt < CONFIG_CACHE_TTL) {
        return _configCache.row
      }
      const row = yield* Database.query(
        "AccountDB.getConfig",
        (db) => db.select().from(config).where(eq(config.id, 1)).get(),
        executor,
      )
      const configRow: ConfigRow = {
        id: row!.id,
        active_account_id: row!.activeAccountId ?? null,
        active_org_id: row!.activeOrgId ?? null,
      }
      _configCache = { row: configRow, cachedAt: now }
      return configRow
    })
  }

  function invalidateConfigCache() {
    _configCache = undefined
  }

  // ============================================================================
  // Account operations
  // ============================================================================

  /** Convert a Drizzle row to the legacy AccountRow type */
  function toAccountRow(row: typeof account.$inferSelect): AccountRow {
    return {
      id: row.id,
      email: row.email,
      url: row.url,
      access_token: row.accessToken,
      refresh_token: row.refreshToken,
      token_expiry: row.tokenExpiry,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    }
  }

  export function getAccount(id: string, executor?: Executor) {
    return Database.query(
      "AccountDB.getAccount",
      (db) => {
        const row = db.select().from(account).where(eq(account.id, id)).get()
        return row ? toAccountRow(row) : undefined
      },
      executor,
    )
  }

  export function listAccounts(executor?: Executor) {
    return Database.query(
      "AccountDB.listAccounts",
      (db) => {
        return db.select().from(account).orderBy(account.id).all().map(toAccountRow)
      },
      executor,
    )
  }

  export function upsertAccount(row: AccountRow, executor?: Executor) {
    return Database.query(
      "AccountDB.upsertAccount",
      (db) => {
        db.insert(account)
          .values({
            id: row.id,
            email: row.email,
            url: row.url,
            accessToken: row.access_token,
            refreshToken: row.refresh_token,
            tokenExpiry: row.token_expiry,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          })
          .onConflictDoUpdate({
            target: account.id,
            set: {
              email: row.email,
              url: row.url,
              accessToken: row.access_token,
              refreshToken: row.refresh_token,
              tokenExpiry: row.token_expiry,
              updatedAt: row.updated_at,
            },
          })
          .run()
      },
      executor,
    )
  }

  /**
   * Persist only the token fields — does NOT overwrite email, url, or created_at.
   * This fixes the critical bug where upsertAccount with blank fields destroyed user data.
   */
  export function persistToken(
    id: string,
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
    executor?: Executor,
  ) {
    return Database.query(
      "AccountDB.persistToken",
      (db) => {
        const now = Date.now()
        db.update(account)
          .set({
            accessToken,
            refreshToken,
            tokenExpiry: now + expiresIn * 1000,
            updatedAt: now,
          })
          .where(eq(account.id, id))
          .run()
      },
      executor,
    )
  }

  export function deleteAccount(id: string, executor?: Executor) {
    return Database.query(
      "AccountDB.deleteAccount",
      (db) => {
        const result = db.delete(account).where(eq(account.id, id)).run()
        return getChanges(result) > 0
      },
      executor,
    )
  }

  // ============================================================================
  // Config operations
  // ============================================================================

  export function getConfig(executor?: Executor) {
    return getConfigCached(executor)
  }

  export function setActiveAccount(accountId: string | null, executor?: Executor) {
    return Database.query(
      "AccountDB.setActiveAccount",
      (db) => {
        db.update(config).set({ activeAccountId: accountId }).where(eq(config.id, 1)).run()
        invalidateConfigCache()
      },
      executor,
    )
  }

  export function setActiveOrg(orgId: string | null, executor?: Executor) {
    return Database.query(
      "AccountDB.setActiveOrg",
      (db) => {
        db.update(config).set({ activeOrgId: orgId }).where(eq(config.id, 1)).run()
        invalidateConfigCache()
      },
      executor,
    )
  }

  /**
   * Get the active account ID (uses cached config).
   */
  export function getActiveAccountId(executor?: Executor) {
    return Database.query(
      "AccountDB.getActiveAccountId",
      (db) => {
        return getConfigCached(db).pipe(Effect.map((row) => row.active_account_id ?? undefined))
      },
      executor,
    )
  }

  /**
   * Get the active org ID (uses cached config).
   */
  export function getActiveOrgId(executor?: Executor) {
    return Database.query(
      "AccountDB.getActiveOrgId",
      (db) => {
        return getConfigCached(db).pipe(Effect.map((row) => row.active_org_id ?? undefined))
      },
      executor,
    )
  }
}
