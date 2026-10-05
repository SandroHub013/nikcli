import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { removeTestDir } from "../helpers/fs"
import { preserveTestEnv } from "../helpers/env"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * EOT-15 requirement 7: "each consumer maintains a per-aggregate cursor
 * `(aggregateID, watermark)`. Global cursors are **derived** from the
 * per-aggregate cursors; they are not authoritative."
 *
 * `RemoteSyncClient` held one `lastSeq` — the maximum `seq` it had seen across
 * *every* aggregate — and passed it as `?since=` to `/sync/outbox`. Two facts
 * make that wrong, and neither is a judgement call:
 *
 *   1. `seq` is handed out **per aggregate**. `Sync.reserveSeqAndAppend`
 *      (`src/sync/index.ts`) reads its counter with
 *      `and(eq(projectId), eq(aggregate))`, so every aggregate counts from 1.
 *   2. `/sync/outbox` filters `projectId = ? AND seq > since`
 *      (`src/server/httpapi/sync.ts`) — **no aggregate predicate**.
 *
 * So `since = max(seq)` is a cursor for a stream that does not exist. An
 * aggregate that is merely *less active* than another has its events silently
 * skipped forever: aggregate A at seq 60 and aggregate B at seq 5 means a
 * reconnect asking `since=60` never sees B's 6, 7, 8.
 *
 * This file drives the real class end to end. `fetch` is replaced with the
 * server's exact query and `EventSource` with a controllable double, so the
 * loss is observed rather than asserted from the source.
 */

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-remote-cursor-"))
process.env.NIKCLI_TEST_HOME = testDir
process.env.NIKCLI_DB = path.join(testDir, "nikcli.db")

preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DB"])

const { RemoteSyncClient } = await import("@/sync/remote-client")
type Record_ = {
  id: string
  projectId: string
  aggregate: string
  seq: number
  type: string
  data: unknown
}

afterAll(async () => {
  await removeTestDir(testDir)
})

/**
 * Replica of the sync server's outbox, so the test exercises the client's
 * real query-building rather than a stub shaped to the client's assumptions.
 * `seq` is per aggregate, exactly as `reserveSeqAndAppend` assigns it.
 */
class FakeHub {
  readonly projectID: string
  log: Record_[] = []
  sinceQueries: number[] = []
  queries: URL[] = []
  private ids = 0

  constructor(projectID: string) {
    this.projectID = projectID
  }

  append(aggregate: string, count: number): Record_[] {
    const written: Record_[] = []
    for (let i = 0; i < count; i++) {
      const seq = this.log.filter((e) => e.aggregate === aggregate).length + 1
      const event: Record_ = {
        id: `e${this.ids++}`,
        projectId: this.projectID,
        aggregate,
        seq,
        type: "test.event",
        data: { n: seq },
      }
      this.log.push(event)
      written.push(event)
    }
    return written
  }

  /** `packages/nikcli/src/server/httpapi/sync.ts` — the real predicate. */
  outbox(url: URL) {
    this.queries.push(url)
    const since = Number(url.searchParams.get("since") ?? 0)
    const aggregate = url.searchParams.get("afterAggregate")
    const id = url.searchParams.get("afterID")
    this.sinceQueries.push(since)
    const rows = this.log
      .filter(
        (e) =>
          e.projectId === this.projectID &&
          (e.seq > since ||
            (aggregate !== null &&
              id !== null &&
              e.seq === since &&
              (e.aggregate > aggregate || (e.aggregate === aggregate && e.id > id)))),
      )
      .sort((a, b) => a.seq - b.seq || compare(a.aggregate, b.aggregate) || compare(a.id, b.id))
    const events = rows.slice(0, 500)
    const last = events.at(-1)
    return {
      events,
      hasMore: rows.length > 500,
      ...(last
        ? {
            nextCursor: {
              seq: last.seq,
              aggregate: last.aggregate,
              id: last.id,
            },
          }
        : {}),
    }
  }
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  private listeners = new Map<string, (event: Event) => void>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, fn: (event: Event) => void) {
    this.listeners.set(type, fn)
  }

  close() {}

  /** Deliver a live event to the client, as the real stream would. */
  push(event: Record_) {
    this.listeners.get("sync")?.({
      data: JSON.stringify(event),
    } as MessageEvent)
  }

  fireError() {
    this.listeners.get("error")?.({} as Event)
  }
}

const realFetch = globalThis.fetch
const realEventSource = globalThis.EventSource

afterEach(() => {
  globalThis.fetch = realFetch
  globalThis.EventSource = realEventSource
  FakeEventSource.instances = []
})

function install(hub: FakeHub) {
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/sync/outbox")) {
      return new Response(JSON.stringify(hub.outbox(url)), {
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("{}", {
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

describe("RemoteSyncClient cursors are per aggregate, not global", () => {
  it("does not lose a quiet aggregate's events on reconnect", async () => {
    const projectID = "proj_cursor"
    const hub = new FakeHub(projectID)
    install(hub)

    // A busy aggregate and a quiet one. This is the whole shape of the bug: a
    // single global cursor is whatever the *busiest* aggregate reached.
    const busyA = hub.append("session:busy", 60)
    const quietB = hub.append("session:quiet", 5)

    const received: Record_[] = []
    const client = new RemoteSyncClient({
      url: "https://hub.invalid",
      token: "t",
      projectID,
      onEvent: (event) => {
        received.push(event as unknown as Record_)
      },
    })

    await client.start()
    const stream = FakeEventSource.instances[0]!
    for (const event of busyA) stream.push(event)
    for (const event of quietB) stream.push(event)

    // While the stream is down, the quiet aggregate moves on.
    const missed = hub.append("session:quiet", 3) // seq 6, 7, 8

    // Reconnect: the client catches up from whatever it believes it has seen.
    await client.catchUp()

    const got = new Set(received.map((e) => `${e.aggregate}#${e.seq}`))
    for (const event of missed) {
      expect(got.has(`${event.aggregate}#${event.seq}`)).toBe(true)
    }
    client.stop()
  })

  it("starts each replay at zero, including when every known cursor has advanced", async () => {
    const projectID = "proj_cursor_since"
    const hub = new FakeHub(projectID)
    install(hub)

    const received: Record_[] = []
    const client = new RemoteSyncClient({
      url: "https://hub.invalid",
      token: "t",
      projectID,
      onEvent: (event) => {
        received.push(event as unknown as Record_)
      },
    })

    await client.start()
    const stream = FakeEventSource.instances[0]!
    for (const event of hub.append("session:busy", 60)) stream.push(event)
    for (const event of hub.append("session:quiet", 5)) stream.push(event)

    hub.append("session:quiet", 2)
    await client.catchUp()

    const last = hub.sinceQueries[hub.sinceQueries.length - 1]!
    expect(last).toBe(0)
    client.stop()
  })

  it("delivers each replayed event exactly once, even when the query over-returns", async () => {
    const projectID = "proj_cursor_once"
    const hub = new FakeHub(projectID)
    install(hub)

    const received: Record_[] = []
    const client = new RemoteSyncClient({
      url: "https://hub.invalid",
      token: "t",
      projectID,
      onEvent: (event) => {
        received.push(event as unknown as Record_)
      },
    })

    await client.start()
    const stream = FakeEventSource.instances[0]!
    const first = hub.append("s1", 3)
    for (const event of first) stream.push(event)
    await Bun.sleep(0)

    // The project-wide query necessarily over-returns: it cannot filter by
    // aggregate, so `s1`'s already-delivered events come back in the batch.
    // Deduping is the client's job, since the endpoint cannot do it.
    hub.append("s1", 2)
    hub.append("s2", 2)
    const before = received.length
    await client.catchUp()

    const fresh = received.slice(before)
    expect(new Set(fresh.map((e) => `${e.aggregate}#${e.seq}`)).size).toBe(fresh.length)
    expect(received.filter((e) => e.id === "e0")).toHaveLength(1)
    client.stop()
  })

  it("follows composite pages across equal sequences and fully deduplicated pages", async () => {
    const hub = new FakeHub("proj_pages")
    for (let n = 0; n < 501; n++) hub.append(`aggregate:${String(n).padStart(3, "0")}`, 1)
    // Equal seq and aggregate must also be paged by id, as the endpoint does.
    hub.log.push({ ...hub.log[499], id: "z_same_aggregate" })
    install(hub)
    const received: Record_[] = []
    const client = new RemoteSyncClient({
      url: "https://hub.invalid",
      token: "t",
      projectID: hub.projectID,
      onEvent(event) {
        received.push(event as unknown as Record_)
      },
    })
    try {
      await client.catchUp()
      expect(received).toHaveLength(501)
      expect(hub.queries).toHaveLength(2)
      expect(hub.queries[1].searchParams.get("since")).toBe("1")
      expect(hub.queries[1].searchParams.get("afterAggregate")).toBe("aggregate:499")
      expect(hub.queries[1].searchParams.get("afterID")).toBe(hub.log[499].id)

      const fresh = hub.append("aggregate:999", 1)[0]
      await client.catchUp()
      expect(hub.queries).toHaveLength(4)
      expect(hub.queries[2].searchParams.get("since")).toBe("0")
      expect(received.at(-1)?.id).toBe(fresh.id)
      expect(received).toHaveLength(502)
    } finally {
      client.stop()
    }
  })

  it("discovers a new aggregate below all known watermarks", async () => {
    const hub = new FakeHub("proj_unknown")
    hub.append("known", 10)
    install(hub)
    const received: Record_[] = []
    const client = new RemoteSyncClient({
      url: "https://hub.invalid",
      token: "t",
      projectID: hub.projectID,
      onEvent(event) {
        received.push(event as unknown as Record_)
      },
    })
    try {
      await client.catchUp()
      const fresh = hub.append("unknown", 1)[0]
      await client.catchUp()
      expect(received.map((event) => event.id)).toEqual(hub.log.map((event) => event.id))
      expect(received.at(-1)?.id).toBe(fresh.id)
    } finally {
      client.stop()
    }
  })

  for (const asynchronous of [false, true]) {
    it(`keeps a live event unconsumed when its callback ${asynchronous ? "rejects" : "throws"}`, async () => {
      const hub = new FakeHub(`proj_live_reject_${asynchronous}`)
      install(hub)
      const delivered: number[] = []
      const unhandled: unknown[] = []
      let fail = true
      const client = new RemoteSyncClient({
        url: "https://hub.invalid",
        token: "t",
        projectID: hub.projectID,
        onEvent(event) {
          if (fail) {
            fail = false
            if (asynchronous) return Promise.reject(new Error("live callback failed"))
            throw new Error("live callback failed")
          }
          delivered.push(event.seq)
        },
      })
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason)
      }
      process.on("unhandledRejection", onUnhandled)
      try {
        // Start against an empty hub so the failure comes from the live path.
        await client.start()
        const live = hub.append("aggregate", 1)[0]!
        FakeEventSource.instances[0]!.push(live)
        await Bun.sleep(20)

        // The failure is handled rather than left to kill the stream: nothing
        // escapes as an unhandled rejection.
        expect(unhandled).toEqual([])
        expect(delivered).toEqual([])

        // And the failed event is not marked consumed, so the next replay
        // redelivers it instead of skipping it forever.
        await client.catchUp()
        expect(delivered).toEqual([1])
      } finally {
        process.off("unhandledRejection", onUnhandled)
        client.stop()
      }
    })
  }

  for (const asynchronous of [false, true]) {
    it(`retries a ${asynchronous ? "rejected" : "throwing"} callback without skipping or redelivering successes`, async () => {
      const hub = new FakeHub("proj_retry")
      hub.append("aggregate", 3)
      install(hub)
      const attempts: number[] = []
      let fail = true
      const client = new RemoteSyncClient({
        url: "https://hub.invalid",
        token: "t",
        projectID: hub.projectID,
        onEvent(event) {
          attempts.push(event.seq)
          if (event.seq !== 2 || !fail) return
          fail = false
          if (asynchronous) return Promise.reject(new Error("callback failed"))
          throw new Error("callback failed")
        },
      })
      try {
        await expect(client.catchUp()).rejects.toThrow("callback failed")
        expect(attempts).toEqual([1, 2])
        await client.catchUp()
        expect(attempts).toEqual([1, 2, 2, 3])
        await client.catchUp()
        expect(attempts).toEqual([1, 2, 2, 3])
      } finally {
        client.stop()
      }
    })
  }
})
