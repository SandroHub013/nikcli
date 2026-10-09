import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import fsp from "fs/promises"
import os from "os"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package B (2), remote sync: kept. The hub is any `ragu serve` (/sync/event,
 * /sync/outbox, /sync/stream) at a URL the user chooses, so it can be self-hosted like `mobile pair`; Nik's
 * s.nikcli-ai.dev only appeared as the example. Its one tie to Nik went: without a token of its own, the client
 * borrowed the token of the signed-in Nik account. Now a hub URL without a token does not start, and says why.
 */
const testHome = await fsp.mkdtemp(path.join(os.tmpdir(), "ragu-sync-hub-home-"))
process.env.RAGU_TEST_HOME = testHome
process.env.RAGU_SKIP_PLUGIN_INSTALL = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")
preserveTestEnv([
  "RAGU_TEST_HOME",
  "RAGU_SKIP_PLUGIN_INSTALL",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const { Global } = await import("@ragu/util/global")
const { SyncConfig } = await import("@/sync/sync-config")

afterAll(async () => {
  const { Database } = await import("@/database/database")
  Database.closeAll()
  await removeTestDir(testHome)
})

const PACKAGES = path.join(import.meta.dir, "../../..")
const read = (file: string) => fs.readFileSync(path.join(PACKAGES, file), "utf8")

describe("remote sync without Nik", () => {
  test("a hub URL without a token does not start, and says why; no account token is read", async () => {
    // A signed-in account with a valid token: the old resolver handed this token to the hub.
    const { Database } = await import("@/database/database")
    const db = Database.syncNative()
    const now = Date.now()
    db.run(
      "INSERT OR REPLACE INTO account (id, email, url, access_token, refresh_token, token_expiry, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "acc_sync_hub",
        "user@example.com",
        "http://127.0.0.1:9",
        "account_access_token",
        "account_refresh",
        now + 3_600_000,
        now,
        now,
      ],
    )
    db.run("INSERT OR REPLACE INTO config (id, active_account_id) VALUES (1, ?)", ["acc_sync_hub"])
    await fsp.mkdir(Global.Path.config, { recursive: true })
    await fsp.writeFile(
      path.join(Global.Path.config, "nikcli.json"),
      JSON.stringify({ sync: { url: "http://127.0.0.1:4096" } }),
    )
    SyncConfig.invalidate()
    const resolved = await SyncConfig.resolve()
    expect(resolved.url).toBe("http://127.0.0.1:4096")
    expect(resolved.token).toBeUndefined()
    expect(resolved.configured).toBe(false)
    expect(resolved.reason).toContain("token")
    expect(JSON.stringify(resolved)).not.toContain("account_access_token")
    expect(read("ragu/src/sync/sync-config.ts")).not.toMatch(/Account|account\.token/)
  })

  test("no example or placeholder points at Nik's hub", () => {
    for (const file of [
      "ragu/src/sync/remote-sync.ts",
      "ragu/src/sync/remote-client.ts",
      "ragu/src/cli/handlers/serve.ts",
      "tui/src/component/dialog-sync.tsx",
      "ragu/src/cli/commands.ts",
      "ragu/src/mobile/auth.sql.ts",
    ])
      expect([file, read(file).includes("nikcli-ai.dev")]).toEqual([file, false])
    expect(read("ragu/src/config/config.ts")).not.toContain("e.g. https://s.nikcli-ai.dev")
  })
})
