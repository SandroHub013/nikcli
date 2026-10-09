import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import fsp from "fs/promises"
import os from "os"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C: the `$schema` URLs pointed at nikcli-ai.dev (config.json, tui.json,
 * theme.json, desktop-theme.json). Loading a config without one wrote it into the user's file; migrating to tui.json,
 * creating a theme in the TUI and generating the desktop themes wrote it too, and every bundled theme carried it. None
 * of that is written any more and the bundled themes drop it.
 */
const testHome = await fsp.mkdtemp(path.join(os.tmpdir(), "ragu-schema-urls-home-"))
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

const ROOT = path.join(import.meta.dir, "../../../..")
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")
const NIK_SCHEMA = /nikcli-ai\.dev\/(config|tui|theme|desktop-theme)\.json/

describe("no $schema pointing at Nik", () => {
  it("loading a config without $schema leaves the user's file as it was", async () => {
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "ragu-schema-urls-")))
    made.push(root)
    const original = JSON.stringify({ theme: "kept" }, null, 2)
    const file = path.join(root, "ragu.json")
    await fsp.writeFile(file, original)
    const config = (await Effect.runPromise(
      InstanceScope.with(
        { directory: root },
        Effect.gen(function* () {
          return yield* (yield* Config.Service).get()
        }).pipe(Effect.provide(Config.defaultLayer)),
      ),
    )) as Record<string, unknown>
    expect(config.theme).toBe("kept")
    expect(await fsp.readFile(file, "utf8")).toBe(original)
  })

  it("nothing we write names Nik's schemas", () => {
    for (const file of [
      "packages/ragu/src/config/config.ts",
      "packages/ragu/src/config/migrate-tui-config.ts",
      "packages/tui/src/component/dialog-theme-create.tsx",
      "packages/ui/script/generate-themes.ts",
    ])
      expect([file, NIK_SCHEMA.test(read(file))]).toEqual([file, false])
  })

  it("no bundled theme carries Nik's schema", () => {
    const hits: string[] = []
    for (const dir of [
      "packages/tui/src/context/theme",
      "packages/ui/src/theme/themes",
      "packages/mobile/lib/themes",
      ".nikcli/themes",
      "themes",
    ]) {
      const full = path.join(ROOT, dir)
      if (!fs.existsSync(full)) continue
      for (const name of fs.readdirSync(full, { recursive: true }) as string[])
        if (name.endsWith(".json") && NIK_SCHEMA.test(read(path.join(dir, name)))) hits.push(path.join(dir, name))
    }
    expect(hits).toEqual([])
  })
})
