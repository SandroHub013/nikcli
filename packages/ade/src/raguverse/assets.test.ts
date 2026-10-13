import { describe, expect, test } from "bun:test"
import { POLL_MS, createAssetsFlow, fetchingView, type AssetsHost, type AssetsStatus, type AssetsView } from "./assets"

const status = (change: Partial<AssetsStatus> = {}): AssetsStatus => ({
  ready: false,
  missing_files: 3,
  missing_bytes: 6_000_000,
  running: false,
  files_done: 0,
  files_total: 3,
  bytes_done: 0,
  bytes_total: 6_000_000,
  error: null,
  ...change,
})

/** A clock the test turns by hand: what is scheduled runs when `tick` says so, and only if it was not cancelled. */
function clock() {
  const queue: Array<{ fn: () => void; ms: number; live: boolean }> = []
  return {
    schedule(fn: () => void, ms: number) {
      const item = { fn, ms, live: true }
      queue.push(item)
      return () => {
        item.live = false
      }
    },
    /** Runs what is due now (one round of the queue) and lets the promises it started settle. */
    async tick() {
      const due = queue.splice(0).filter((item) => item.live)
      for (const item of due) item.fn()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    pending: () => queue.filter((item) => item.live).length,
  }
}

function setup(host: AssetsHost | undefined) {
  const time = clock()
  const views: AssetsView[] = []
  const events: string[] = []
  const flow = createAssetsFlow({
    host,
    view: (view) => {
      views.push(view)
      events.push(`view:${view.kind}`)
    },
    ready: (complete) => events.push(`ready:${complete}`),
    schedule: time.schedule,
  })
  return { flow, time, views, events }
}

describe("the panel's end of the assets fetch", () => {
  test("without a host to ask, the world starts as it is and nothing is shown", async () => {
    const { flow, views, events } = setup(undefined)
    await flow.start()
    expect(events).toEqual(["ready:true"])
    expect(views).toEqual([])
    const half = setup({ nikverseAssetsStatus: async () => status() })
    await half.flow.start()
    expect(half.events).toEqual(["ready:true"])
  })

  test("with every file in place the frame starts at once and the panel says nothing", async () => {
    let installs = 0
    const { flow, events } = setup({
      nikverseAssetsStatus: async () => status({ ready: true, missing_files: 0, missing_bytes: 0 }),
      nikverseAssetsInstall: async () => void installs++,
    })
    await flow.start()
    expect(events).toEqual(["view:ready", "ready:true"])
    expect(installs).toBe(0)
  })

  test("with files missing they are fetched first and the frame starts after, not before: it would load twice", async () => {
    let finish: () => void = () => {}
    const { flow, events } = setup({
      nikverseAssetsStatus: async () => status(),
      nikverseAssetsInstall: () => new Promise<void>((resolve) => (finish = resolve)),
    })
    const started = flow.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(["view:fetching"])
    expect(events.some((e) => e.startsWith("ready"))).toBe(false)
    finish()
    await started
    expect(events).toEqual(["view:fetching", "view:ready", "ready:true"])
  })

  test("while it runs the progress is read from the host and shown", async () => {
    let finish: () => void = () => {}
    let reading = status()
    const { flow, time, views } = setup({
      nikverseAssetsStatus: async () => reading,
      nikverseAssetsInstall: () => new Promise<void>((resolve) => (finish = resolve)),
    })
    const started = flow.start()
    await time.tick()
    reading = status({ running: true, bytes_done: 3_000_000, files_done: 1 })
    await time.tick()
    const last = views.at(-1)
    expect(last).toMatchObject({ kind: "fetching", percent: 50 })
    finish()
    await started
    // Nothing is left to read once it is over.
    expect(time.pending()).toBe(0)
  })

  test("a fetch that fails says why, offers no frame-blocking wall, and the world starts with its placeholders", async () => {
    const { flow, events, views } = setup({
      nikverseAssetsStatus: async () => status(),
      nikverseAssetsInstall: async () => {
        throw new Error("Il file scaricato non corrisponde a quello atteso: scartato.")
      },
    })
    await flow.start()
    expect(events).toEqual(["view:fetching", "view:failed", "ready:false"])
    expect(views.at(-1)).toEqual({ kind: "failed", reason: "Il file scaricato non corrisponde a quello atteso: scartato." })
  })

  test("an error that is not an Error still gives a reason, and «riprova» is another start", async () => {
    let fail = true
    const { flow, events, views } = setup({
      nikverseAssetsStatus: async () => status(),
      nikverseAssetsInstall: async () => {
        if (fail) throw "offline"
      },
    })
    await flow.start()
    expect(views.at(-1)).toEqual({ kind: "failed", reason: "offline" })
    fail = false
    events.length = 0
    await flow.start()
    expect(events).toEqual(["view:fetching", "view:ready", "ready:true"])
  })

  test("a second start while one runs does nothing", async () => {
    let finish: () => void = () => {}
    let installs = 0
    const { flow } = setup({
      nikverseAssetsStatus: async () => status(),
      nikverseAssetsInstall: () => {
        installs++
        return new Promise<void>((resolve) => (finish = resolve))
      },
    })
    const first = flow.start()
    await flow.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    finish()
    await first
    expect(installs).toBe(1)
  })

  test("a panel that is gone starts nothing and stops reading", async () => {
    let finish: () => void = () => {}
    const { flow, events, time } = setup({
      nikverseAssetsStatus: async () => status(),
      nikverseAssetsInstall: () => new Promise<void>((resolve) => (finish = resolve)),
    })
    const started = flow.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    flow.dispose()
    finish()
    await started
    expect(events).toEqual(["view:fetching"])
    expect(time.pending()).toBe(0)
  })

  test("the view of a fetch: a percentage only when there is a total, in megabytes, never past the ends", () => {
    expect(fetchingView({ bytes_done: 1_572_864, bytes_total: 6_291_456, missing_bytes: 6_291_456 })).toEqual({
      kind: "fetching",
      percent: 25,
      megabytes: 6,
    })
    expect(fetchingView({ bytes_done: 9e9, bytes_total: 1000, missing_bytes: 1000 })).toMatchObject({ percent: 100 })
    // No progress total yet (the first look): the missing bytes stand in for it.
    expect(fetchingView({ bytes_done: 0, bytes_total: 0, missing_bytes: 5_242_880 })).toEqual({
      kind: "fetching",
      percent: 0,
      megabytes: 5,
    })
    expect(fetchingView({ bytes_done: 0, bytes_total: 0, missing_bytes: 0 })).toMatchObject({ percent: undefined })
    expect(POLL_MS).toBeLessThanOrEqual(1000)
  })
})
