import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

/*
 * Brief (10): `RAGU_CONFIG_CONTENT` was merged before the config folders, so any folder won over it; it is merged
 * after every file and folder now. The folders keep their order (review of correction 2, point 2): the outermost
 * one, the user's own, wins over a project's, so a downloaded repository's `.nikcli` cannot undo the user's.
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

  it("the user's home folder still wins over the project's", async () => {
    // `Global.Path.home` is the test home.
    const mine = path.join(testHome, ".nikcli")
    await fs.mkdir(mine, { recursive: true })
    await fs.writeFile(path.join(mine, "nikcli.json"), JSON.stringify({ theme: "home", username: "home" }))
    try {
      const directory = await project({ ".nikcli/nikcli.json": { theme: "project" } })
      const config = await loaded(directory)
      expect(config.theme).toBe("home")
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
