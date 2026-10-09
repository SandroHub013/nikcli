import { afterAll, describe, expect, test } from "bun:test"
import { removeTestDir } from "../helpers/fs"
import { preserveTestEnv } from "../helpers/env"
import { guardNikFetch } from "../helpers/no-nik-fetch"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/*
 * Brief ragu-via-servizi-nik, package B (3): a request the local server does not handle was proxied to
 * app.nikcli-ai.dev, Nik's web app. It answers 404, locally.
 */
const home = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-no-proxy-"))
process.env.RAGU_TEST_HOME = home
process.env.RAGU_TEST_MODE = "1"
process.env.RAGU_DISABLE_PROJECT_CONFIG = "1"
process.env.RAGU_DISABLE_MODELS_FETCH = "1"
process.env.XDG_DATA_HOME = path.join(home, "data")
process.env.XDG_CACHE_HOME = path.join(home, "cache")
process.env.XDG_CONFIG_HOME = path.join(home, "config")
process.env.XDG_STATE_HOME = path.join(home, "state")
preserveTestEnv([
  "RAGU_TEST_HOME",
  "RAGU_TEST_MODE",
  "RAGU_DISABLE_PROJECT_CONFIG",
  "RAGU_DISABLE_MODELS_FETCH",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const { Server } = await import("@/server/server")
const { Instance } = await import("@/project/instance")

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  const { Database } = await import("@/database/database")
  Database.closeAll()
  await removeTestDir(home)
})

describe("the local server", () => {
  test("a path it does not serve answers 404 without asking Nik's web app", async () => {
    const guard = guardNikFetch()
    try {
      for (const pathname of ["/", "/some/web/page", "/assets/app.js"]) {
        const url = new URL(pathname, "http://ragu.local")
        url.searchParams.set("directory", home)
        const response = await Server.fetch(new Request(url))
        expect([pathname, response.status]).toEqual([pathname, 404])
      }
      expect(guard.attempts).toEqual([])
    } finally {
      guard.restore()
    }
  }, 60_000)
})
