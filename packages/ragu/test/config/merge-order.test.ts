import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

/*
 * Brief (10): the config folders merged nearest first, so the farthest `.nikcli` won over the project's own,
 * and `RAGU_CONFIG_CONTENT` was merged before them, so any folder won over it. The last one merged wins:
 * the global folder, the home's, the project's from the farthest to the nearest, `RAGU_CONFIG_DIR`, and
 * `RAGU_CONFIG_CONTENT` after all of them.
 */
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-config-order-home-"))
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
  "RAGU_CONFIG_CONTENT",
  "RAGU_CONFIG_DIR",
])

const { InstanceScope } = await import("@/effect")
const { Config } = await import("@/config/config")
const { Instance } = await import("@/project/instance")

const made: string[] = []

async function project(files: Record<string, unknown>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ragu-config-order-")))
  made.push(root)
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), JSON.stringify(content))
  }
  return root
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

describe("the order config folders merge in", () => {
  it("lists the global folder, the home's, the project's from the farthest to the nearest, then RAGU_CONFIG_DIR", () => {
    const home = path.join("/h")
    const global = path.join("/h/.config/ragu")
    const near = path.join("/h/w/repo/sub/.ragu")
    const far = path.join("/h/w/repo/.nikcli")
    const mine = path.join("/h/.nikcli")
    const custom = path.join("/elsewhere/conf")
    // As `ConfigPaths.directories` lists them: the project's nearest first.
    const listed = [global, near, far, mine, custom]
    expect(Config.mergeOrder(listed, home, custom)).toEqual([global, mine, far, near, custom])
    expect(Config.mergeOrder([global, near, far, mine], home, undefined)).toEqual([global, mine, far, near])
    // A folder listed twice is merged once, in its first place.
    expect(Config.mergeOrder([global, near, near, mine], home, undefined)).toEqual([global, mine, near])
  })

  it("RAGU_CONFIG_CONTENT wins over the project's folder", async () => {
    const directory = await project({ ".nikcli/nikcli.json": { theme: "folder", username: "folder" } })
    process.env.RAGU_CONFIG_CONTENT = JSON.stringify({ theme: "content" })
    const config = await loaded(directory)
    expect(config.theme).toBe("content")
    // What the content does not set, the folder still does.
    expect(config.username).toBe("folder")
  })

  it("RAGU_CONFIG_CONTENT wins over RAGU_CONFIG_DIR", async () => {
    const custom = await project({ "nikcli.json": { theme: "dir" } })
    const directory = await project({})
    process.env.RAGU_CONFIG_DIR = custom
    process.env.RAGU_CONFIG_CONTENT = JSON.stringify({ theme: "content" })
    expect((await loaded(directory)).theme).toBe("content")
  })

  it("the project's folder wins over the home's", async () => {
    // `Global.Path.home` is the test home.
    const mine = path.join(testHome, ".nikcli")
    await fs.mkdir(mine, { recursive: true })
    await fs.writeFile(path.join(mine, "nikcli.json"), JSON.stringify({ theme: "home", username: "home" }))
    try {
      const directory = await project({ ".nikcli/nikcli.json": { theme: "project" } })
      const config = await loaded(directory)
      expect(config.theme).toBe("project")
      expect(config.username).toBe("home")
    } finally {
      await fs.rm(mine, { recursive: true, force: true })
    }
  })
})

afterEach(async () => {
  delete process.env.RAGU_CONFIG_CONTENT
  delete process.env.RAGU_CONFIG_DIR
  await Instance.disposeAll().catch(() => undefined)
})

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  const { Database } = await import("@/database/database")
  Database.closeAll()
  await Promise.all(made.map((dir) => removeTestDir(dir)))
  await removeTestDir(testHome)
})
