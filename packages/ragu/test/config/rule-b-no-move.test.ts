import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

/*
 * Rule B reads the ragu folder when it exists, else the nikcli one, and never copies, moves or deletes
 * either: a user's data folder is gigabytes, and `ragu migrate` is the only thing that moves it.
 */
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-rule-b-home-"))
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

// With it, the loader leaves a file as it is (without, it writes the line in: not rule B's doing).
const SCHEMA = "https://nikcli-ai.dev/config.json"

const made: string[] = []

async function project(files: Record<string, string>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ragu-rule-b-")))
  made.push(root)
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), content)
  }
  return root
}

/** Every file under `root` with its content: what a copy, a move or a delete would change. */
async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const full = path.join(entry.parentPath, entry.name)
    out[path.relative(root, full).replaceAll("\\", "/")] = await fs.readFile(full, "utf8")
  }
  return out
}

function loaded(directory: string) {
  return Effect.runPromise(
    InstanceScope.with(
      { directory },
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.get()
      }).pipe(Effect.provide(Config.defaultLayer)),
    ),
  )
}

describe("rule B never copies, moves or deletes a folder", () => {
  it("only .nikcli: read, and no .ragu appears", async () => {
    const directory = await project({
      ".nikcli/nikcli.json": JSON.stringify({ $schema: SCHEMA, theme: "vecchio" }),
      ".nikcli/agent/bot.md": "---\ndescription: B\n---\nCiao",
    })
    const before = await tree(directory)
    expect((await loaded(directory)).theme).toBe("vecchio")
    expect(await tree(directory)).toEqual(before)
  })

  it("both: .ragu read, .nikcli left as it is", async () => {
    const directory = await project({
      ".nikcli/nikcli.json": JSON.stringify({ $schema: SCHEMA, theme: "vecchio" }),
      ".nikcli/agent/bot.md": "---\ndescription: B\n---\nCiao",
      ".ragu/ragu.json": JSON.stringify({ $schema: SCHEMA, theme: "nuovo" }),
    })
    const before = await tree(directory)
    expect((await loaded(directory)).theme).toBe("nuovo")
    expect(await tree(directory)).toEqual(before)
  })
})

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  const { Database } = await import("@/database/database")
  Database.closeAll()
  await Promise.all(made.map((dir) => removeTestDir(dir)))
  await removeTestDir(testHome)
})
