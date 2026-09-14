import { preserveTestEnv } from "../helpers/env"
import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mobile-pairing-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_TEST_MODE = "1"
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_TEST_MODE",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])
for (const dir of ["data", "cache", "config", "state"]) {
  await fs.mkdir(path.join(testHome, dir), { recursive: true })
}

const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mobile-pairing-project-")))
const { Instance } = await import("@/project/instance")
const { Server } = await import("@/server/server")

/** A local client: the loopback pipeline the TUI talks to, with no credential. */
function request(pathname: string, init?: RequestInit) {
  return Server.fetch(
    new Request(`http://nikcli.local${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-nikcli-directory": projectDir,
        ...init?.headers,
      },
    }),
  )
}

afterAll(async () => {
  await Server.stopMobile()
  await Instance.disposeAll().catch(() => undefined)
  await fs.rm(testHome, { recursive: true, force: true })
  await fs.rm(projectDir, { recursive: true, force: true })
})

describe("mobile pairing listener", () => {
  it("reports no listener before one is asked for", async () => {
    const response = await request("/mobile/host/lan")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ listening: false })
  })

  it("opens one LAN listener, and reuses it on a second pairing", async () => {
    const first = await request("/mobile/host/lan", { method: "POST", body: JSON.stringify({ mdns: false }) })
    expect(first.status).toBe(200)
    const listener = (await first.json()) as { listening: boolean; url: string; port: number }
    expect(listener.listening).toBe(true)
    expect(listener.port).toBeGreaterThan(0)
    expect(listener.url).toBe(`http://0.0.0.0:${listener.port}`)

    const second = await request("/mobile/host/lan", { method: "POST", body: JSON.stringify({ mdns: false }) })
    expect(await second.json()).toEqual(listener)

    const status = await request("/mobile/host/lan")
    expect(await status.json()).toEqual(listener)
  })

  it("demands a mobile token on the LAN socket while the local one stays open", async () => {
    const started = await request("/mobile/host/lan", { method: "POST", body: JSON.stringify({ mdns: false }) })
    const { port } = (await started.json()) as { port: number }
    const lan = (init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}/mobile/bootstrap?directory=${encodeURIComponent(projectDir)}`, init)

    expect((await lan()).status).toBe(401)
    expect((await lan({ headers: { authorization: "Bearer not-a-token" } })).status).toBe(401)

    const created = (await (
      await request("/mobile/auth/token", { method: "POST", body: JSON.stringify({ name: "pairing-test" }) })
    ).json()) as { token: string }
    expect((await lan({ headers: { authorization: `Bearer ${created.token}` } })).status).toBe(200)

    // The regression this listener exists for: requiring a mobile token used to
    // be a process-wide flag, which answered 401 to the TUI that asked for the
    // pairing link in the first place.
    expect((await request("/mobile/auth/token")).status).toBe(200)
  })
})
