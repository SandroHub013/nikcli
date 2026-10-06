import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, describe, expect, it, spyOn } from "bun:test"

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-sync-transport-"))
process.env.NIKCLI_TEST_HOME = testDir
process.env.NIKCLI_DB = path.join(testDir, "nikcli.db")
process.env.XDG_DATA_HOME = path.join(testDir, "data")

preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DB", "XDG_DATA_HOME"])

const { createHttpRemoteTransport, createInMemoryRemoteTransport, createInMemoryScheduler, realScheduler } =
  await import("@/sync/transport")
import type { SyncEventRecord } from "@/sync"

const run = Math.random().toString(36).slice(2)

afterAll(async () => {
  if (process.env.NIKCLI_DB === path.join(testDir, "nikcli.db")) {
    const { Database } = await import("@/database/database")
    Database.closeAll()
    await removeTestDir(testDir)
  }
})

const sampleEvent = (seq: number): SyncEventRecord => ({
  id: `evt_${seq}_${run}`,
  projectId: `proj_${run}`,
  aggregate: `wrk_${run}`,
  seq,
  type: "test.event",
  data: { n: seq },
  timestamp: Date.now(),
  origin: "remote:test",
})

describe("InMemoryRemoteTransport", () => {
  it("pullBacklog returns events newer than `since`", async () => {
    const transport = createInMemoryRemoteTransport()
    transport.enqueue(sampleEvent(1))
    transport.enqueue(sampleEvent(2))
    transport.enqueue(sampleEvent(3))

    const page = await transport.pullBacklog(1)
    expect(page.events.map((e) => e.seq)).toEqual([2, 3])
    expect(page.hasMore).toBe(false)
  })

  it("subscribe delivers events and can be unsubscribed", async () => {
    const transport = createInMemoryRemoteTransport()
    const received: number[] = []
    const unsubscribe = transport.subscribe((event) => {
      received.push(event.seq)
    })
    transport.enqueue(sampleEvent(1))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(received).toEqual([1])

    unsubscribe()
    transport.enqueue(sampleEvent(2))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(received).toEqual([1])
  })

  it("push returns the next override outcome when set", async () => {
    const transport = createInMemoryRemoteTransport()
    transport.setNextPush({ ok: false, permanent: true, error: "HTTP 401" })
    const outcome = await transport.push(sampleEvent(1))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.permanent).toBe(true)
    expect(transport.pushed).toHaveLength(0)

    const ok = await transport.push(sampleEvent(2))
    expect(ok.ok).toBe(true)
    expect(transport.pushed).toHaveLength(1)
  })

  it("close clears subscribers", () => {
    const transport = createInMemoryRemoteTransport()
    const unsubscribe = transport.subscribe(() => undefined)
    transport.close()
    // After close, the underlying set is cleared. Calling enqueue with no
    // subscribers must not throw.
    transport.enqueue(sampleEvent(1))
    unsubscribe()
  })
})

describe("InMemoryScheduler", () => {
  it("fires interval callbacks when tick advances past the period", () => {
    const scheduler = createInMemoryScheduler({ initialNow: 0 })
    let count = 0
    const handle = scheduler.interval(() => count++, 1_000)

    scheduler.tick(2_500)
    expect(count).toBe(2) // tick at 1000 and 2000
    handle.clear()
    scheduler.tick(5_000)
    expect(count).toBe(2)
    scheduler.tick(10_000)
    expect(scheduler.pendingCount()).toBe(0)
  })

  it("runs one-shot timers at the right time", () => {
    const scheduler = createInMemoryScheduler({ initialNow: 0 })
    let fired = false
    scheduler.timeout(() => (fired = true), 500)
    scheduler.tick(499)
    expect(fired).toBe(false)
    scheduler.tick(1)
    expect(fired).toBe(true)
    scheduler.tick(5_000)
    expect(scheduler.pendingCount()).toBe(0)
  })

  it("now() tracks the simulated clock", () => {
    const scheduler = createInMemoryScheduler({ initialNow: 100 })
    expect(scheduler.now()).toBe(100)
    scheduler.tick(250)
    expect(scheduler.now()).toBe(350)
  })
})

describe("HttpRemoteTransport", () => {
  for (const payload of ["{", "null", JSON.stringify({ projectId: "wrong", id: "e", aggregate: "a", seq: 1 })]) {
    it(`recovers readiness after malformed SSE ${payload}`, async () => {
      const sources: Source[] = []
      class Source extends EventTarget {
        closed = false
        constructor(readonly url: string) {
          super()
          sources.push(this)
        }
        close() {
          this.closed = true
        }
      }
      const states: string[] = []
      const received: number[] = []
      const errors: unknown[] = []
      const transport = createHttpRemoteTransport({
        url: "http://hub",
        token: "token",
        projectID: `proj_${run}`,
        eventSourceImpl: Source as unknown as typeof EventSource,
        reopenDelayMs: 1,
        onError(error) {
          errors.push(error)
        },
      })
      try {
        transport.subscribe(
          (event) => {
            received.push(event.seq)
          },
          {
            ready() {
              states.push("ready")
            },
            stale() {
              states.push("stale")
            },
            wake() {
              states.push("wake")
            },
          },
        )
        sources[0].dispatchEvent(new Event("ready"))
        sources[0].dispatchEvent(new MessageEvent("sync", { data: payload }))
        expect(errors).toHaveLength(1)
        expect(states).toEqual(["ready", "stale"])
        expect(sources[0].closed).toBe(true)
        // Recovery is deferred, not immediate: a hub that keeps emitting
        // malformed frames must not be hit with a hot reconnect loop.
        expect(sources).toHaveLength(1)
        await Bun.sleep(20)
        expect(sources).toHaveLength(2)
        expect(new URL(sources[1].url).searchParams.get("readiness")).toBe("1")

        sources[0].dispatchEvent(new Event("ready"))
        sources[0].dispatchEvent(new MessageEvent("sync", { data: JSON.stringify(sampleEvent(1)) }))
        sources[0].dispatchEvent(new MessageEvent("sync", { data: "{" }))
        expect(states).toEqual(["ready", "stale"])
        expect(errors).toHaveLength(1)
        expect(received).toEqual([])

        sources[1].dispatchEvent(new Event("ready"))
        sources[1].dispatchEvent(new MessageEvent("sync", { data: JSON.stringify(sampleEvent(2)) }))
        expect(states).toEqual(["ready", "stale", "ready"])
        expect(received).toEqual([2])
        transport.close()
        sources[1].dispatchEvent(new MessageEvent("sync", { data: "{" }))
        expect(sources).toHaveLength(2)
        expect(sources[1].closed).toBe(true)
      } finally {
        transport.close()
      }
    })
  }

  it("backs off across consecutive malformed frames and still recovers", async () => {
    const openedAt: number[] = []
    const sources: Source[] = []
    // Assert the delays the transport *schedules*, not the wall-clock gaps
    // between opens. A 20ms timer observed inside a 43-test process measured
    // 182ms, so a gap-based bound is a coin flip on a loaded runner; the
    // scheduled delay is the actual property and is exact.
    const scheduled: number[] = []
    const realSetTimeout = globalThis.setTimeout
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: never, ms?: never, ...rest: never[]) => {
      if (typeof ms === "number" && ms <= 30_000) scheduled.push(ms)
      return realSetTimeout(fn, ms, ...rest)
    }) as never)
    class Source extends EventTarget {
      constructor(readonly url: string) {
        super()
        sources.push(this)
        openedAt.push(Date.now())
      }
      close() {}
    }
    const received: number[] = []
    const transport = createHttpRemoteTransport({
      url: "http://hub",
      token: "token",
      projectID: "p",
      eventSourceImpl: Source as unknown as typeof EventSource,
      reopenDelayMs: 20,
    })
    try {
      transport.subscribe(
        (event) => {
          received.push(event.seq)
        },
        { ready() {}, stale() {}, wake() {} },
      )
      // Consecutive failures cost progressively more. Against the un-backed-off
      // path every delay is the base and this fails on the second assert.
      sources[0].dispatchEvent(new MessageEvent("sync", { data: "{" }))
      await Bun.sleep(200)
      expect(sources).toHaveLength(2)
      sources[1].dispatchEvent(new MessageEvent("sync", { data: "{" }))
      await Bun.sleep(200)
      expect(sources).toHaveLength(3)
      expect(scheduled[0]).toBe(20)
      expect(scheduled[1]).toBe(40)

      // Still recoverable: the replacement stream re-fences and delivers again.
      sources[2].dispatchEvent(new Event("ready"))
      sources[2].dispatchEvent(
        new MessageEvent("sync", {
          data: JSON.stringify({ ...sampleEvent(9), projectId: "p" }),
        }),
      )
      expect(received).toEqual([9])

      // A stream that reached `ready` is trusted again, so the next malformed
      // frame restarts at the base delay instead of the escalated one.
      sources[2].dispatchEvent(new MessageEvent("sync", { data: "{" }))
      await Bun.sleep(200)
      expect(sources).toHaveLength(4)
      expect(scheduled[2]).toBe(20)
    } finally {
      transport.close()
      timer.mockRestore()
    }
  })

  it("does not reopen a malformed stream when stale handling unsubscribes or closes", () => {
    for (const close of [false, true]) {
      const sources: Source[] = []
      class Source extends EventTarget {
        closed = false
        constructor() {
          super()
          sources.push(this)
        }
        close() {
          this.closed = true
        }
      }
      const transport = createHttpRemoteTransport({
        url: "http://hub",
        token: "token",
        projectID: "p",
        eventSourceImpl: Source as unknown as typeof EventSource,
      })
      const unsubscribe = transport.subscribe(() => {}, {
        ready() {},
        stale() {
          if (close) transport.close()
          else unsubscribe()
        },
        wake() {},
      })
      try {
        sources[0].dispatchEvent(new MessageEvent("sync", { data: "{" }))
        expect(sources).toHaveLength(1)
        expect(sources[0].closed).toBe(true)
      } finally {
        transport.close()
      }
    }
  })

  it("refreshes stream auth, fences each reconnect, and cannot reopen after close", async () => {
    const sources: Source[] = []
    class Source extends EventTarget {
      constructor(readonly url: string) {
        super()
        sources.push(this)
      }
      close() {}
    }
    let release: ((token: string) => void) | undefined
    let ready = 0
    let stale = 0
    const transport = createHttpRemoteTransport({
      url: "http://hub",
      token: "expired",
      projectID: "p",
      eventSourceImpl: Source as unknown as typeof EventSource,
      resolveToken: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    })
    transport.subscribe(() => {}, {
      ready() {
        ready++
      },
      stale() {
        stale++
      },
      wake() {},
    })
    sources[0].dispatchEvent(new Event("open"))
    expect(ready).toBe(0)
    sources[0].dispatchEvent(new Event("ready"))
    expect(ready).toBe(1)
    sources[0].dispatchEvent(Object.assign(new Event("error"), { code: 401 }))
    expect(stale).toBe(1)
    release!("fresh")
    for (let n = 0; n < 20 && sources.length < 2; n++) await Bun.sleep(1)
    expect(sources).toHaveLength(2)
    expect(new URL(sources[1].url).searchParams.get("token")).toBe("fresh")
    sources[1].dispatchEvent(new Event("ready"))
    expect(ready).toBe(2)
    sources[1].dispatchEvent(Object.assign(new Event("error"), { code: 401 }))
    transport.close()
    release!("newer")
    await Bun.sleep(5)
    expect(sources).toHaveLength(2)
    sources[1].dispatchEvent(new Event("ready"))
    expect(ready).toBe(2)
  })
  it("uses the eventsource polyfill when the runtime has no native EventSource", () => {
    const transport = createHttpRemoteTransport({
      url: "http://localhost",
      token: "x",
      projectID: "p",
      eventSourceImpl: undefined as never,
    })
    transport.close()
  })

  it("delegates push and pullBacklog to the injected fetch", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = Object.assign(
      async (input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        const url = String(input)
        if (url.includes("/sync/outbox")) {
          return new Response(JSON.stringify({ events: [], hasMore: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response("{}", { status: 200 })
      },
      { preconnect: () => undefined },
    ) as unknown as typeof fetch

    const transport = createHttpRemoteTransport({
      url: "http://hub.example",
      token: "tok",
      projectID: "proj_http",
      fetchImpl: fakeFetch,
      // Inject a no-op EventSource to satisfy the constructor.
      eventSourceImpl: class {
        url: string
        withCredentials = false
        readyState = 0
        onopen: ((e: Event) => void) | null = null
        onmessage: ((e: MessageEvent) => void) | null = null
        onerror: ((e: Event) => void) | null = null
        constructor(url: string) {
          this.url = url
        }
        addEventListener() {
          /* no-op */
        }
        removeEventListener() {
          /* no-op */
        }
        close() {
          /* no-op */
        }
        dispatchEvent() {
          return true
        }
      } as unknown as typeof EventSource,
    })

    const backlog = await transport.pullBacklog(0)
    expect(backlog.events).toEqual([])
    expect(calls.some((c) => c.url.includes("/sync/outbox"))).toBe(true)

    await transport.pullBacklog(0, {
      seq: 7,
      aggregate: "aggregate:cursor",
      id: "event:cursor",
    })
    const pageUrl = new URL(calls.at(-1)!.url)
    expect(pageUrl.searchParams.get("projectID")).toBe("proj_http")
    expect(pageUrl.searchParams.get("since")).toBe("7")
    expect(pageUrl.searchParams.get("afterAggregate")).toBe("aggregate:cursor")
    expect(pageUrl.searchParams.get("afterID")).toBe("event:cursor")

    const ok = await transport.push(sampleEvent(7))
    expect(ok.ok).toBe(true)
    expect(calls.some((c) => c.url.endsWith("/sync/event"))).toBe(true)
    transport.close()
  })

  it("re-resolves the token and retries once after HTTP 401", async () => {
    const authorizations: string[] = []
    let requests = 0
    let resolutions = 0
    const fakeFetch = Object.assign(
      async (_input: unknown, init?: RequestInit) => {
        requests++
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "")
        return new Response("{}", { status: requests === 1 ? 401 : 200 })
      },
      { preconnect: () => undefined },
    ) as unknown as typeof fetch

    const transport = createHttpRemoteTransport({
      url: "http://hub.example",
      token: "expired",
      resolveToken: async () => {
        resolutions++
        return "fresh"
      },
      projectID: "proj_refresh",
      fetchImpl: fakeFetch,
    })

    const outcome = await transport.push(sampleEvent(8))
    expect(outcome.ok).toBe(true)
    expect(requests).toBe(2)
    expect(resolutions).toBe(1)
    expect(authorizations).toEqual(["Bearer expired", "Bearer fresh"])
    transport.close()
  })
})

describe("realScheduler", () => {
  it("interval and clear work against the real clock", () => {
    let count = 0
    const handle = realScheduler.interval(() => count++, 5)
    setTimeout(() => handle.clear(), 25)
    return new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      expect(count).toBeGreaterThan(0)
    })
  })
})
