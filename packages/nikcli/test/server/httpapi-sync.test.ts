import { preserveTestEnv } from "../helpers/env"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-httpapi-sync-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"

preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DISABLE_PROJECT_CONFIG"])

const { Instance } = await import("@/project/instance")
const { HttpApiBridge } = await import("@/server/httpapi/bridge")
const { Server } = await import("@/server/server")

const projectDirs: string[] = []

async function makeProjectDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-httpapi-sync-project-"))
  const resolved = await fs.realpath(dir)
  projectDirs.push(resolved)
  return resolved
}

async function request(method: string, pathname: string, directory: string, body?: unknown) {
  const url = new URL(pathname, "http://nikcli.local")
  url.searchParams.set("directory", directory)
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" }
    init.body = JSON.stringify(body)
  }
  return Server.fetch(new Request(url, init))
}

/**
 * The `/sync/*` surface is served by Effect HttpApi. The stream bypasses body
 * encoding through a framework-neutral Web Request/Response SSE handler.
 */
describe("Sync HttpApi contract (realigned to Hono routes)", () => {
  it("no longer advertises the removed Wave 4 phantom routes on the bridge", () => {
    expect(HttpApiBridge.supports("/sync/start", "POST")).toBe(false)
    expect(HttpApiBridge.supports("/sync/replay", "POST")).toBe(false)
    expect(HttpApiBridge.supports("/sync/history", "GET")).toBe(false)
    expect(HttpApiBridge.supports("/sync/snapshot", "GET")).toBe(false)
  })

  it("describes the real /sync routes with the Hono operationIds", async () => {
    const { OpenApi } = await import("effect/unstable/httpapi")
    const { PublicApi } = await import("@/server/httpapi/public")
    const spec = OpenApi.fromApi(PublicApi) as {
      paths: Record<string, Record<string, { operationId?: string }>>
    }
    const op = (p: string, m: string) => spec.paths[p]?.[m]?.operationId
    expect(op("/sync/event", "post")).toBe("sync.event.push")
    expect(op("/sync/outbox", "get")).toBe("sync.outbox.list")
    expect(op("/sync/snapshot/{aggregateID}", "get")).toBe("sync.snapshot.get")
    expect(op("/sync/stream", "get")).toBe("sync.event.stream")
    expect(op("/sync/stats", "get")).toBe("sync.stats")
    expect(op("/sync/config", "post")).toBe("sync.config.set")
    expect(op("/sync/connect", "post")).toBe("sync.connect")
    expect(op("/sync/disconnect", "post")).toBe("sync.disconnect")
    expect(op("/sync/drain", "post")).toBe("sync.drain")
    // The phantom endpoints must not resurface.
    expect(spec.paths["/sync/start"]).toBeUndefined()
    expect(spec.paths["/sync/history"]).toBeUndefined()
  })

  it("bridges every migrated route", () => {
    expect(HttpApiBridge.supports("/sync/event", "POST")).toBe(true)
    expect(HttpApiBridge.supports("/sync/outbox", "GET")).toBe(true)
    expect(HttpApiBridge.supports("/sync/snapshot/wrk_1", "GET")).toBe(true)
    expect(HttpApiBridge.supports("/sync/stream", "GET")).toBe(true)
    expect(HttpApiBridge.supports("/sync/stats", "GET")).toBe(true)
    expect(HttpApiBridge.supports("/sync/config", "POST")).toBe(true)
    expect(HttpApiBridge.supports("/sync/connect", "POST")).toBe(true)
    expect(HttpApiBridge.supports("/sync/disconnect", "POST")).toBe(true)
    expect(HttpApiBridge.supports("/sync/drain", "POST")).toBe(true)
  })

  it("GET /sync/outbox returns an empty page when no events exist (Effect)", async () => {
    const directory = await makeProjectDir()
    const response = await request("GET", "/sync/outbox?projectID=proj_1", directory)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      events: unknown[]
      hasMore: boolean
    }
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.events.length).toBe(0)
    expect(body.hasMore).toBe(false)
  })

  it("pages project-wide sequence ties with an additive composite keyset", async () => {
    const { Sync } = await import("@/sync")
    const directory = await makeProjectDir()
    const projectID = `paging_${Date.now()}`
    for (let n = 0; n < 601; n++) {
      await Sync.emitRaw(projectID, `tie_${String(n).padStart(4, "0")}`, { n })
    }
    const first = await request("GET", `/sync/outbox?projectID=${projectID}`, directory)
    const page = (await first.json()) as {
      events: { id: string; seq: number }[]
      hasMore: boolean
      nextCursor: { seq: number; aggregate: string; id: string }
    }
    expect(page.events).toHaveLength(500)
    expect(page.events.every((e) => e.seq === 1)).toBe(true)
    expect(page.hasMore).toBe(true)
    const cursor = page.nextCursor
    const second = await request(
      "GET",
      `/sync/outbox?projectID=${projectID}&since=${cursor.seq}&afterAggregate=${cursor.aggregate}&afterID=${cursor.id}`,
      directory,
    )
    const tail = (await second.json()) as typeof page
    expect(tail.events).toHaveLength(101)
    expect(tail.hasMore).toBe(false)
    expect(new Set([...page.events, ...tail.events].map((e) => e.id)).size).toBe(601)
    const legacy = await request("GET", `/sync/outbox?projectID=${projectID}&since=1`, directory)
    expect(((await legacy.json()) as typeof page).events).toHaveLength(0)
    const invalid = await request("GET", `/sync/outbox?projectID=${projectID}&afterID=only`, directory)
    expect(invalid.status).toBe(400)
  })

  it("GET /sync/outbox restricts to one aggregate, which is the per-aggregate cursor's missing half", async () => {
    // The loss table in `specs/effect-tui/15-sync-snapshots-watermarks.md`: `seq`
    // counts per aggregate, and the endpoint filtered only on `projectID AND seq
    // > since`, so one `since` addressed every aggregate's own numbering at once.
    // A consumer holding per-aggregate cursors had to ask with the *lowest* cursor
    // and discard whatever came back for aggregates it already had.
    const { Sync } = await import("@/sync")
    const directory = await makeProjectDir()
    const projectID = `aggfilter_${Date.now()}`
    const quiet = "session:quiet"
    // The busy aggregate runs its sequence far past the quiet one's, exactly the
    // imbalance the table describes: the quieter the aggregate, the more certain
    // it was to be skipped.
    for (let n = 1; n <= 60; n++) await Sync.emitRaw(projectID, "session:busy", { n })
    for (let n = 1; n <= 5; n++) await Sync.emitRaw(projectID, quiet, { n })

    type Page = {
      events: { id: string; aggregate: string; seq: number }[]
      hasMore: boolean
    }
    const read = async (query: string) => (await (await request("GET", query, directory)).json()) as Page

    // Project-wide, from the quiet aggregate's cursor: the busy aggregate's 55
    // remaining events are all returned and all discarded by the client.
    const wide = await read(`/sync/outbox?projectID=${projectID}&since=5`)
    expect(wide.events).toHaveLength(55)
    expect(wide.events.every((e) => e.aggregate === "session:busy")).toBe(true)

    // The same cursor, scoped to the aggregate that actually owns it: the quiet
    // aggregate's own tail, and nothing else.
    const scoped = await read(`/sync/outbox?projectID=${projectID}&since=5&aggregate=${encodeURIComponent(quiet)}`)
    expect(scoped.events).toHaveLength(0)
    expect(scoped.hasMore).toBe(false)

    const quietTail = await read(`/sync/outbox?projectID=${projectID}&since=3&aggregate=${encodeURIComponent(quiet)}`)
    expect(quietTail.events.map((e) => e.seq)).toEqual([4, 5])

    // Additive, in both directions: omitting the parameter is the old page, and
    // an unknown aggregate is an empty page rather than an error.
    const omitted = await read(`/sync/outbox?projectID=${projectID}`)
    expect(omitted.events).toHaveLength(65)
    const unknown = await read(`/sync/outbox?projectID=${projectID}&aggregate=session%3Anothing`)
    expect(unknown.events).toHaveLength(0)
  })

  it("GET /sync/snapshot/:aggregateID preserves the legacy 400 text response", async () => {
    const directory = await makeProjectDir()
    const response = await request("GET", "/sync/snapshot/unknown_1?projectID=proj_1", directory)
    expect(response.status).toBe(400)
    expect(await response.text()).toBe("Unsupported aggregate kind")
  })

  it("POST /sync/event is idempotent and preserves 204 responses", async () => {
    const directory = await makeProjectDir()
    const payload = {
      projectID: "proj_effect_sync",
      event: {
        id: `evt_${Date.now()}`,
        projectId: "proj_effect_sync",
        aggregate: "wrk_effect_sync",
        seq: 42,
        type: "workspace.updated",
        data: { ok: true },
        timestamp: Date.now(),
      },
    }
    const first = await request("POST", "/sync/event", directory, payload)
    const duplicate = await request("POST", "/sync/event", directory, payload)
    expect(first.status).toBe(204)
    expect(duplicate.status).toBe(204)
  })

  it("rate limits event pushes per token and returns retry-after", async () => {
    const { MobileAuth } = await import("@/mobile/auth")
    const directory = await makeProjectDir()
    const created = await MobileAuth.create({
      name: "test-rate-limit",
      scope: "cli-sync",
    })
    let limited: Response | undefined
    for (let index = 0; index < 101; index++) {
      const response = await request("POST", `/sync/event?token=${created.token}`, directory, {
        projectID: "proj_rate_limit",
        event: {
          id: `evt_rate_limit_${index}`,
          projectId: "proj_rate_limit",
          aggregate: "wrk_rate_limit",
          seq: index + 1,
          type: "workspace.updated",
          data: { index },
          timestamp: Date.now(),
        },
      })
      if (response.status === 429) {
        limited = response
        break
      }
      expect(response.status).toBe(204)
    }
    expect(limited?.status).toBe(429)
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(await limited?.text()).toBe("Rate limit exceeded")
  })

  it("preserves no-content status and headers for TUI actions", async () => {
    const directory = await makeProjectDir()
    for (const route of ["disconnect", "drain"]) {
      const response = await request("POST", `/sync/${route}`, directory)
      expect(response.status).toBe(204)
      expect(await response.text()).toBe("")
    }
  })

  it("raw SSE opens promptly with the legacy headers", async () => {
    const { MobileAuth } = await import("@/mobile/auth")
    const directory = await makeProjectDir()
    const created = await MobileAuth.create({
      name: "test-stream",
      scope: "cli-sync",
    })
    const controller = new AbortController()
    const url = new URL(`/sync/stream?projectID=proj_1&token=${created.token}`, "http://nikcli.local")
    url.searchParams.set("directory", directory)
    const response = await Server.fetch(new Request(url, { signal: controller.signal }))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")
    expect(response.headers.get("connection")).toBe("keep-alive")
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe(": connected\n\n")
    controller.abort()
    await reader.cancel()
  })
})

/**
 * Auth tests for the `?token=` security scheme on `/sync/*`. Mirrors the
 * Effect sync scope guard:
 *  - invalid token → 401
 *  - valid token with sync-capable scope (`mobile`, `cli-sync`) → 200
 */
describe("Sync auth_token scope guard", () => {
  it("rejects ?token=<unknown> with 401 Unauthorized", async () => {
    const directory = await makeProjectDir()
    const response = await request("GET", "/sync/outbox?token=invalid_token_xyz&projectID=proj_1", directory)
    expect(response.status).toBe(401)
    const body = await response.text()
    expect(body).toContain("Unauthorized")
  })

  it("accepts ?token=<mobile-scope>", async () => {
    const { MobileAuth } = await import("@/mobile/auth")
    const directory = await makeProjectDir()
    const created = await MobileAuth.create({
      name: "test-mobile",
      scope: "mobile",
    })
    const response = await request("GET", `/sync/outbox?token=${created.token}&projectID=proj_1`, directory)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      events: unknown[]
      hasMore: boolean
    }
    expect(Array.isArray(body.events)).toBe(true)
  })

  it("accepts ?token=<cli-sync-scope>", async () => {
    const { MobileAuth } = await import("@/mobile/auth")
    const directory = await makeProjectDir()
    const created = await MobileAuth.create({
      name: "test-cli-sync",
      scope: "cli-sync",
    })
    const response = await request("GET", `/sync/outbox?token=${created.token}&projectID=proj_1`, directory)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      events: unknown[]
      hasMore: boolean
    }
    expect(Array.isArray(body.events)).toBe(true)
  })

  it("accepts ?token=<studio-scope>", async () => {
    const { MobileAuth } = await import("@/mobile/auth")
    const directory = await makeProjectDir()
    const created = await MobileAuth.create({
      name: "test-studio",
      scope: "studio",
    })
    const response = await request("GET", `/sync/outbox?token=${created.token}&projectID=proj_1`, directory)
    expect(response.status).toBe(200)
  })
})

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

afterAll(async () => {
  await Promise.all(projectDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)))
  await fs.rm(testHome, { recursive: true, force: true }).catch(() => undefined)
})
