import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, common rules: the config keys of a removed service are still accepted when a user
 * has them in ragu.json / nikcli.json, and ignored (with a warning in the log): an old config must not stop the
 * start. One case per removed key.
 */
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-removed-keys-home-"))
process.env.RAGU_TEST_HOME = testHome
delete process.env.RAGU_DISABLE_PROJECT_CONFIG
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")
process.env.RAGU_SKIP_PLUGIN_INSTALL = "1"

preserveTestEnv([
  "RAGU_TEST_HOME",
  "RAGU_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "RAGU_SKIP_PLUGIN_INSTALL",
])

const { InstanceScope } = await import("@/effect")
const { Config } = await import("@/config/config")
const { Instance } = await import("@/project/instance")

const made: string[] = [testHome]
afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  for (const dir of made) await removeTestDir(dir)
})

async function loaded(config: Record<string, unknown>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ragu-removed-keys-")))
  made.push(root)
  await fs.writeFile(path.join(root, "nikcli.json"), JSON.stringify(config))
  return Effect.runPromise(
    InstanceScope.with(
      { directory: root },
      Effect.gen(function* () {
        return yield* (yield* Config.Service).get()
      }).pipe(Effect.provide(Config.defaultLayer)),
    ),
  ) as Promise<Record<string, unknown>>
}

/** A removed key: loading a config that has it works, keeps the rest, and drops the key. */
const REMOVED: Record<string, unknown> = {
  analytics: { share: true, endpoint: "https://dashboard.nikcli-ai.dev/api/community/report" },
  teleport: { url: "https://my-server.up.railway.app", token: "mobile-token" },
  autoupdate: true,
  share: "auto",
  autoshare: true,
}

describe("config keys of Nik's removed services", () => {
  for (const [key, value] of Object.entries(REMOVED))
    it(`\`${key}\` is accepted and ignored`, async () => {
      const config = await loaded({ theme: "kept", [key]: value })
      expect(config.theme).toBe("kept")
      expect(key in config).toBe(false)
    })

  it("the keybinds of removed features are accepted and ignored", async () => {
    const config = await loaded({ keybinds: { session_share: "<leader>s", session_unshare: "none", session_new: "<leader>n" } })
    const keybinds = config.keybinds as Record<string, unknown>
    expect(keybinds.session_new).toBe("<leader>n")
    expect("session_share" in keybinds).toBe(false)
    expect("session_unshare" in keybinds).toBe(false)
  })
})
