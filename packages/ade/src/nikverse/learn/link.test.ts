import { describe, expect, test } from "bun:test"
import { createLearnLink, readFromPage } from "./link"
import { emptyProgress } from "./progress"

/** A port that only records what ADE sent through it. */
function fakePort() {
  const sent: unknown[] = []
  let closed = false
  const port = {
    postMessage: (message: unknown) => void sent.push(message),
    close: () => {
      closed = true
    },
  } as unknown as MessagePort
  return { port, sent, isClosed: () => closed }
}

/** A promise settled from the outside, to say when a read or a write finishes. */
function deferred<T = void>() {
  let resolve!: (value?: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value as T)
    reject = rej
  })
  return { promise, resolve, reject }
}

const progress = (xp: number) => ({ ...emptyProgress(), xp })
const answered = (xp: number) => ({ type: "learn-save", progress: progress(xp) })

/** Lets every promise that can already move do so. */
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function setup(load: () => Promise<unknown>, save: (json: string) => Promise<void> = async () => {}) {
  const { port, sent, isClosed } = fakePort()
  const ignored: string[] = []
  const saved: string[] = []
  let unreadable = 0
  const loads = { count: 0 }
  const link = createLearnLink({
    port,
    load: () => {
      loads.count++
      return load()
    },
    save: async (json) => {
      saved.push(json)
      await save(json)
    },
    ignored: (reason) => void ignored.push(reason),
    unreadable: () => void unreadable++,
  })
  return { link, sent, saved, ignored, loads, isClosed, unreadable: () => unreadable }
}

describe("readFromPage", () => {
  test("only `ready` and `learn-save` are messages", () => {
    expect(readFromPage({ type: "ready" })).toEqual({ type: "ready" })
    expect(readFromPage({ type: "learn-save", progress: 1 })).toEqual({ type: "learn-save", progress: 1 })
    expect(readFromPage({ type: "run-command" })).toBeUndefined()
    expect(readFromPage("ready")).toBeUndefined()
    expect(readFromPage(null)).toBeUndefined()
  })
})

describe("the channel with the lesson page", () => {
  test("a message of a type ADE does not know is ignored and the reason is given", async () => {
    const t = setup(async () => null)
    t.link.receive({ type: "run-command", command: "rm" })
    await t.link.settled()
    expect(t.saved).toEqual([])
    expect(t.ignored).toHaveLength(1)
    expect(t.ignored[0]).toContain("run-command")
  })

  test("`ready` said twice reads the file once and answers once", async () => {
    const t = setup(async () => progress(7))
    t.link.receive({ type: "ready" })
    t.link.receive({ type: "ready" })
    await flush()
    expect(t.loads.count).toBe(1)
    expect(t.sent).toEqual([{ type: "progress", progress: progress(7) }])
  })

  test("a learner with no file yet opens on nothing and may write", async () => {
    const t = setup(async () => null)
    t.link.receive({ type: "ready" })
    await flush()
    expect(t.sent).toEqual([{ type: "progress", progress: null }])
    t.link.receive(answered(2))
    await t.link.settled()
    expect(t.saved).toEqual([JSON.stringify(progress(2))])
    expect(t.unreadable()).toBe(0)
  })

  test("A: a read that fails is not a first day: nothing is written over the file, and the user is told", async () => {
    const t = setup(async () => {
      throw new Error("file bloccato dall'antivirus")
    })
    t.link.receive({ type: "ready" })
    await flush()
    t.link.receive(answered(2))
    t.link.receive(answered(12))
    await t.link.settled()
    expect(t.saved).toEqual([])
    expect(t.sent).toEqual([])
    expect(t.unreadable()).toBe(1)
    expect(t.ignored.join("\n")).toContain("antivirus")
  })

  test("A: a document that is not a progress is left alone as well", async () => {
    const t = setup(async () => "{rotto")
    t.link.receive({ type: "ready" })
    await flush()
    t.link.receive(answered(2))
    await t.link.settled()
    expect(t.saved).toEqual([])
    expect(t.unreadable()).toBe(1)
  })

  test("B: a progress of another version is neither handed to the page nor written over", async () => {
    const t = setup(async () => ({ v: 2, xp: 900, giorni: [], esercizi: {}, novita: true }))
    t.link.receive({ type: "ready" })
    await flush()
    t.link.receive(answered(902))
    await t.link.settled()
    expect(t.sent).toEqual([])
    expect(t.saved).toEqual([])
    expect(t.unreadable()).toBe(1)
    expect(t.ignored.join("\n")).toContain("versione 2")
  })

  test("a progress the disk has is handed to the page as ADE reads it, and the page may write", async () => {
    const t = setup(async () => ({ ...progress(40), campoNuovo: "va via" }))
    t.link.receive({ type: "ready" })
    await flush()
    expect(t.sent).toEqual([{ type: "progress", progress: progress(40) }])
    t.link.receive(answered(42))
    await t.link.settled()
    expect(t.saved).toEqual([JSON.stringify(progress(42))])
  })

  test("a save said before the read has finished waits for it: written if the read is good, dropped if it is not", async () => {
    const good = deferred<unknown>()
    const early = setup(() => good.promise)
    early.link.receive({ type: "ready" })
    early.link.receive(answered(5))
    await flush()
    expect(early.saved).toEqual([])
    good.resolve(progress(3))
    await early.link.settled()
    expect(early.saved).toEqual([JSON.stringify(progress(5))])

    const bad = deferred<unknown>()
    const late = setup(() => bad.promise)
    late.link.receive({ type: "ready" })
    late.link.receive(answered(5))
    await flush()
    bad.reject(new Error("illeggibile"))
    await late.link.settled()
    expect(late.saved).toEqual([])
  })

  test("C: two saves close together are written one at a time and in the order they were said", async () => {
    const writes: { json: string; done: ReturnType<typeof deferred<void>> }[] = []
    let running = 0
    let most = 0
    const t = setup(
      async () => null,
      (json) => {
        const done = deferred()
        writes.push({ json, done })
        running++
        most = Math.max(most, running)
        return done.promise.finally(() => void running--)
      },
    )
    t.link.receive({ type: "ready" })
    await flush()
    t.link.receive(answered(2))
    t.link.receive(answered(12))
    await flush()
    // The second one has not started: the first is still being written.
    expect(writes.map((w) => w.json)).toEqual([JSON.stringify(progress(2))])
    writes[0]!.done.resolve()
    await flush()
    expect(writes.map((w) => w.json)).toEqual([JSON.stringify(progress(2)), JSON.stringify(progress(12))])
    writes[1]!.done.resolve()
    await t.link.settled()
    expect(most).toBe(1)
  })

  test("a write that fails does not stop the next one", async () => {
    let n = 0
    const t = setup(
      async () => null,
      async () => {
        if (n++ === 0) throw new Error("disco pieno")
      },
    )
    t.link.receive({ type: "ready" })
    await flush()
    t.link.receive(answered(2))
    t.link.receive(answered(12))
    await t.link.settled()
    expect(t.saved).toEqual([JSON.stringify(progress(2)), JSON.stringify(progress(12))])
    expect(t.ignored.join("\n")).toContain("disco pieno")
  })

  test("a save of a shape that is not a progress is never written", async () => {
    const t = setup(async () => null)
    t.link.receive({ type: "ready" })
    await flush()
    t.link.receive({ type: "learn-save", progress: { v: 9, xp: 1 } })
    t.link.receive({ type: "learn-save", progress: "xp" })
    await t.link.settled()
    expect(t.saved).toEqual([])
    expect(t.ignored).toHaveLength(2)
  })

  test("once closed, the old page writes nothing more, and `settled` waits for the write in flight", async () => {
    const first = deferred()
    const t = setup(
      async () => null,
      () => first.promise,
    )
    t.link.receive({ type: "ready" })
    await flush()
    t.link.receive(answered(2))
    t.link.receive(answered(12))
    await flush()
    t.link.close()
    expect(t.isClosed()).toBe(true)
    let settled = false
    void t.link.settled().then(() => void (settled = true))
    await flush()
    expect(settled).toBe(false)
    first.resolve()
    await t.link.settled()
    expect(t.saved).toEqual([JSON.stringify(progress(2))])
  })
})
