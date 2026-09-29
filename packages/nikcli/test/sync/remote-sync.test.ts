import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, describe, expect, it } from "bun:test"

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-remote-sync-"))
process.env.NIKCLI_TEST_HOME = testDir
process.env.NIKCLI_DB = path.join(testDir, "nikcli.db")
process.env.XDG_DATA_HOME = path.join(testDir, "data")

preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DB", "XDG_DATA_HOME"])

const { RemoteSync } = await import("@/sync/remote-sync")
const { createHttpRemoteTransport, createInMemoryRemoteTransport, createInMemoryScheduler } =
  await import("@/sync/transport")
const { Sync } = await import("@/sync")
import type { SyncEventRecord } from "@/sync"

const run = Math.random().toString(36).slice(2)

afterAll(async () => {
  if (process.env.NIKCLI_DB === path.join(testDir, "nikcli.db")) {
    await removeTestDir(testDir)
  }
})

const sample = (seq: number, type = "remote.injected"): SyncEventRecord => ({
  id: `evt_remote_${seq}_${run}`,
  projectId: `proj_remote_${run}`,
  aggregate: `wrk_remote_${run}`,
  seq,
  type,
  data: { seq },
  timestamp: Date.now(),
  origin: "remote:test",
})

describe("RemoteSync with injected Adapters", () => {
  it("fences HTTP catch-up, pages 601 ties, recovers unknown aggregates and retries application failures", async () => {
    const projectID = `http_active_${run}`
    const scheduler = createInMemoryScheduler()
    const history = Array.from({ length: 601 }, (_, n) => ({
      ...sample(1),
      projectId: projectID,
      id: `tie_${String(n).padStart(4, "0")}`,
      aggregate: `agg_${String(n).padStart(4, "0")}`,
    }))
    let source: Source | undefined
    class Source extends EventTarget {
      constructor(_url: string) {
        super()
        source = this
      }
      close() {}
    }
    let pulls = 0
    let hold: (() => void) | undefined
    let block = false
    const transport = createHttpRemoteTransport({
      url: "http://active.fixture",
      token: "token",
      projectID,
      eventSourceImpl: Source as unknown as typeof EventSource,
      fetchImpl: Object.assign(
        async (input: unknown) => {
          pulls++
          if (block)
            await new Promise<void>((resolve) => {
              hold = resolve
            })
          const url = new URL(String(input))
          const seq = Number(url.searchParams.get("since"))
          const aggregate = url.searchParams.get("afterAggregate")
          const id = url.searchParams.get("afterID")
          const rows = history
            .filter(
              (e) =>
                e.seq > seq ||
                (aggregate !== null &&
                  e.seq === seq &&
                  (e.aggregate > aggregate || (e.aggregate === aggregate && e.id > id!))),
            )
            .sort(
              (a, b) =>
                a.seq - b.seq ||
                (a.aggregate < b.aggregate ? -1 : a.aggregate > b.aggregate ? 1 : a.id < b.id ? -1 : 1),
            )
          const events = rows.slice(0, 500)
          const last = events.at(-1)
          return Response.json({
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
          })
        },
        { preconnect() {} },
      ) as unknown as typeof fetch,
    })
    const handle = await RemoteSync.start({
      url: `http://active.fixture/${run}`,
      token: "token",
      projectID,
      transport,
      scheduler,
    })
    const until = async (condition: () => boolean) => {
      for (let n = 0; n < 200 && !condition(); n++) await Bun.sleep(5)
      expect(condition()).toBe(true)
    }
    try {
      expect(pulls).toBe(0)
      expect(handle.status().connected).toBe(false)
      source!.dispatchEvent(new Event("ready"))
      await until(() => handle.status().connected)
      expect(pulls).toBe(2)
      expect(await Sync.getEvents(projectID, "agg_0600")).toHaveLength(1)
      source!.dispatchEvent(new Event("error"))
      history.push({
        ...sample(1),
        projectId: projectID,
        aggregate: "new_quiet",
        id: "new_quiet",
      })
      history.push({
        ...sample(2),
        projectId: projectID,
        aggregate: "agg_0000",
        id: "busy_tail",
      })
      expect(handle.status().connected).toBe(false)
      const original = Sync.emitRaw
      let failures = 1
      Sync.emitRaw = async (...args: Parameters<typeof original>) => {
        if (args[1] === "new_quiet" && failures-- > 0) throw new Error("application rejected")
        return original(...args)
      }
      try {
        source!.dispatchEvent(new Event("ready"))
        await until(() =>
          Boolean(RemoteSync.lastHubError(`http://active.fixture/${run}`)?.includes("application rejected")),
        )
        expect(handle.status().connected).toBe(false)
        scheduler.tick(5000)
        await until(() => handle.status().connected)
      } finally {
        Sync.emitRaw = original
      }
      expect(await Sync.getEvents(projectID, "new_quiet")).toHaveLength(1)
      expect(await Sync.getEvents(projectID, "agg_0000")).toHaveLength(2)
      block = true
      source!.dispatchEvent(
        new MessageEvent("sync", {
          data: JSON.stringify({ type: "sync.received" }),
        }),
      )
      await until(() => Boolean(hold))
      await handle.stop()
      hold!()
      await Bun.sleep(10)
      expect(handle.status().connected).toBe(false)
      const stoppedPulls = pulls
      source!.dispatchEvent(new Event("ready"))
      scheduler.tick(10000)
      expect(pulls).toBe(stoppedPulls)
      expect(scheduler.pendingCount()).toBe(0)
    } finally {
      await handle.stop()
    }
  })
  it("starts, receives a subscribed event, and stops cleanly", async () => {
    const transport = createInMemoryRemoteTransport()
    const scheduler = createInMemoryScheduler({ initialNow: 0 })
    const projectID = `proj_remote_sync_${run}`
    const url = `https://remote.test/${run}`

    const handle = await RemoteSync.start({
      url,
      token: "tok",
      projectID,
      drainIntervalMs: 1000,
      transport,
      scheduler,
    })

    expect(handle).toBeDefined()
    for (let n = 0; n < 100 && !handle.status().connected; n++) await Bun.sleep(1)
    expect(handle.status().connected).toBe(true)

    // Inject a remote event via the transport. Use the same projectID the
    // RemoteSync was started with, otherwise the local query below won't
    // see it.
    const remoteEvent = sample(1, "remote.injected")
    remoteEvent.projectId = projectID
    transport.enqueue(remoteEvent)
    await new Promise((resolve) => setTimeout(resolve, 30))

    // Local store now contains the replayed event with the remote origin tag
    const stored = await Sync.getEvents(projectID, remoteEvent.aggregate)
    expect(stored.find((e) => e.seq === 1)).toBeDefined()
    expect(stored.find((e) => e.seq === 1)?.origin).toMatch(/^remote:/)

    await handle.stop()
    expect(handle.status().connected).toBe(false)
  })

  it("drainInterval is driven by the scheduler", async () => {
    const transport = createInMemoryRemoteTransport()
    const scheduler = createInMemoryScheduler({ initialNow: 0 })
    const projectID = `proj_remote_sync_drain_${run}`

    // No events pushed yet — drain should be a no-op when nothing is enqueued.
    const handle = await RemoteSync.start({
      url: `https://remote.test/drain/${run}`,
      token: "tok",
      projectID,
      drainIntervalMs: 1000,
      transport,
      scheduler,
    })

    // Advance the fake clock past several intervals
    scheduler.tick(10_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(transport.pushed).toHaveLength(0)

    await handle.stop()
  })
})
