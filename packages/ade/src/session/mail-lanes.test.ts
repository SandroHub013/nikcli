import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  LOCK_GRANT_WINDOW_MS,
  MAIL_LONG_MS,
  MAIL_QUICK_MS,
  MAIL_STEP_MS,
  createMailLanes,
  createWatchedStep,
  dropFrom,
  lockCameTooLate,
  mailDeadline,
  mailLane,
  sentAt,
} from "./mail-lanes"
import { failedReceipt, hungReceipt, lateLockReceipt, type Message } from "./mailbox"

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

type Item = { id: string; lane?: string; ms?: number }

/** The lanes over a queue: every delivery is a promise the test settles by hand, unless it says otherwise. */
const harness = (answers: Record<string, () => Promise<boolean>> = {}) => {
  const started: string[] = []
  const finished: string[] = []
  const hung: { id: string; ms: number }[] = []
  const failed: { id: string; error: unknown }[] = []
  const lanes = createMailLanes<Item>({
    deliver: (item) => {
      started.push(item.id)
      return answers[item.id]?.() ?? Promise.resolve(true)
    },
    laneOf: (item) => item.lane,
    deadlineOf: (item) => item.ms ?? 1000,
    done: (item) => finished.push(item.id),
    hung: (item, ms) => hung.push({ id: item.id, ms }),
    failed: (item, error) => failed.push({ id: item.id, error }),
  })
  return { lanes, started, finished, hung, failed }
}

describe("a slow step does not delay anything else", () => {
  test("a kv is answered while a close is still removing its worktree", async () => {
    const close = deferred<boolean>()
    const { lanes, started, finished } = harness({ close: () => close.promise })
    lanes.start([{ id: "close", lane: "close" }, { id: "kv" }])
    await flush()
    expect(finished).toEqual(["kv"])
    expect(started).toContain("close")
    expect(lanes.inFlight("close")).toBe(true)

    close.resolve(true)
    await flush()
    expect(finished).toEqual(["kv", "close"])
    expect(lanes.inFlight("close")).toBe(false)
  })

  test("a spawn in its git worktree add holds up neither a send nor a reply", async () => {
    const spawn = deferred<boolean>()
    const { lanes, finished } = harness({ spawn: () => spawn.promise })
    lanes.start([
      { id: "spawn", lane: "spawn" },
      { id: "send", lane: "pane:a" },
      { id: "reply", lane: "ref:r1" },
    ])
    await flush()
    expect(finished).toEqual(["send", "reply"])
  })

  test("a typed delivery to one pane does not delay a delivery to another", async () => {
    const paste = deferred<boolean>()
    const { lanes, finished } = harness({ a: () => paste.promise })
    lanes.start([
      { id: "a", lane: "pane:a" },
      { id: "b", lane: "pane:b" },
    ])
    await flush()
    expect(finished).toEqual(["b"])
  })

  test("a new round starts a kv even while a lane is busy", async () => {
    const close = deferred<boolean>()
    const { lanes, finished } = harness({ close: () => close.promise })
    const queue: Item[] = [{ id: "close", lane: "close" }]
    lanes.start(queue)
    await flush()
    lanes.start([...queue, { id: "kv" }])
    await flush()
    expect(finished).toEqual(["kv"])
  })
})

describe("a lane keeps its order", () => {
  test("two messages to one pane: the second starts when the first has finished", async () => {
    const first = deferred<boolean>()
    const { lanes, started, finished } = harness({ one: () => first.promise })
    lanes.start([
      { id: "one", lane: "pane:a" },
      { id: "two", lane: "pane:a" },
    ])
    await flush()
    expect(started).toEqual(["one"])

    first.resolve(true)
    await flush()
    expect(started).toEqual(["one", "two"])
    expect(finished).toEqual(["one", "two"])
  })

  test("a later message does not overtake while the lane is walking, even when it arrives on a new round", async () => {
    const first = deferred<boolean>()
    const { lanes, started } = harness({ one: () => first.promise })
    lanes.start([{ id: "one", lane: "pane:a" }])
    await flush()
    lanes.start([
      { id: "one", lane: "pane:a" },
      { id: "two", lane: "pane:a" },
    ])
    await flush()
    expect(started).toEqual(["one"])

    // The walk that was going knew only the first: the second goes on the next round.
    first.resolve(true)
    await flush()
    lanes.start([{ id: "two", lane: "pane:a" }])
    await flush()
    expect(started).toEqual(["one", "two"])
  })

  test("a message left queued does not hold back the next, as in the old pass", async () => {
    const { lanes, started, finished } = harness({ held: async () => false })
    lanes.start([
      { id: "held", lane: "pane:a" },
      { id: "next", lane: "pane:a" },
    ])
    await flush()
    expect(started).toEqual(["held", "next"])
    expect(finished).toEqual(["next"])
    expect(lanes.inFlight("held")).toBe(false)
  })

  test("a message left queued runs again on the next round, and only then", async () => {
    let times = 0
    const { lanes, finished } = harness({
      held: async () => {
        times++
        return times > 1
      },
    })
    const queue: Item[] = [{ id: "held" }]
    lanes.start(queue)
    await flush()
    expect(finished).toEqual([])
    lanes.start(queue)
    await flush()
    expect(finished).toEqual(["held"])
    expect(times).toBe(2)
  })

  test("a message being delivered is not started a second time", async () => {
    const slow = deferred<boolean>()
    let times = 0
    const { lanes } = harness({
      slow: () => {
        times++
        return slow.promise
      },
    })
    lanes.start([{ id: "slow" }])
    await flush()
    lanes.start([{ id: "slow" }])
    await flush()
    expect(times).toBe(1)
  })
})

describe("a hung step hits the watchdog", () => {
  test("past its deadline it is reported once, and the lane goes on", async () => {
    const never = new Promise<boolean>(() => {})
    const { lanes, started, hung, finished } = harness({ stuck: () => never })
    lanes.start([
      { id: "stuck", lane: "pane:a", ms: 500 },
      { id: "next", lane: "pane:a" },
    ])
    await flush()
    expect(started).toEqual(["stuck"])
    expect(hung).toEqual([])

    jest.advanceTimersByTime(499)
    await flush()
    expect(hung).toEqual([])

    jest.advanceTimersByTime(1)
    await flush()
    expect(hung).toEqual([{ id: "stuck", ms: 500 }])
    expect(started).toEqual(["stuck", "next"])
    expect(finished).toEqual(["next"])

    jest.advanceTimersByTime(10_000)
    await flush()
    expect(hung).toHaveLength(1)
  })

  test("it is never run again, and what it does later no longer counts", async () => {
    const late = deferred<boolean>()
    let times = 0
    const { lanes, hung, finished, failed } = harness({
      stuck: () => {
        times++
        return late.promise
      },
    })
    const queue: Item[] = [{ id: "stuck", ms: 100 }]
    lanes.start(queue)
    await flush()
    jest.advanceTimersByTime(100)
    await flush()
    expect(lanes.abandoned("stuck")).toBe(true)
    expect(lanes.inFlight("stuck")).toBe(false)

    lanes.start(queue)
    await flush()
    expect(times).toBe(1)

    late.resolve(true)
    await flush()
    expect(finished).toEqual([])
    expect(failed).toEqual([])
    expect(hung).toHaveLength(1)
  })

  test("a step that ends in time leaves no timer behind", async () => {
    const { lanes, hung, finished } = harness()
    lanes.start([{ id: "fine", ms: 100 }])
    await flush()
    expect(finished).toEqual(["fine"])
    jest.advanceTimersByTime(1000)
    await flush()
    expect(hung).toEqual([])
    expect(lanes.abandoned("fine")).toBe(false)
  })

  test("a delivery that throws is reported and does not stop the ones behind it", async () => {
    const boom = new Error("boom")
    const { lanes, failed, finished } = harness({
      bad: () => {
        throw boom
      },
    })
    lanes.start([
      { id: "bad", lane: "pane:a" },
      { id: "next", lane: "pane:a" },
    ])
    await flush()
    expect(failed).toEqual([{ id: "bad", error: boom }])
    expect(finished).toEqual(["next"])
  })
})

describe("the round's watchdog", () => {
  test("a stuck round is told once, and a new round can start", async () => {
    const stuck: number[] = []
    const step = createWatchedStep(1000, (ms) => stuck.push(ms))
    let rounds = 0
    const never = () => {
      rounds++
      return new Promise(() => {})
    }

    step(never)
    await flush()
    // Still going: the next round is a no-op.
    step(never)
    await flush()
    expect(rounds).toBe(1)
    expect(stuck).toEqual([])

    jest.advanceTimersByTime(1000)
    await flush()
    expect(stuck).toEqual([1000])

    // The bell hears of it once, however many rounds stick after it.
    step(never)
    await flush()
    expect(rounds).toBe(2)
    jest.advanceTimersByTime(1000)
    await flush()
    expect(stuck).toEqual([1000])
  })

  test("a round that ends in time arms the notice again", async () => {
    const stuck: number[] = []
    const step = createWatchedStep(1000, (ms) => stuck.push(ms))
    step(() => new Promise(() => {}))
    jest.advanceTimersByTime(1000)
    await flush()
    step(async () => {})
    await flush()
    step(() => new Promise(() => {}))
    jest.advanceTimersByTime(1000)
    await flush()
    expect(stuck).toEqual([1000, 1000])
  })

  test("a round that fails is over, and the next one runs", async () => {
    const stuck: number[] = []
    const step = createWatchedStep(1000, (ms) => stuck.push(ms))
    let rounds = 0
    step(async () => {
      rounds++
      throw new Error("no")
    })
    await flush()
    step(async () => {
      rounds++
    })
    await flush()
    expect(rounds).toBe(2)
    jest.advanceTimersByTime(5000)
    await flush()
    expect(stuck).toEqual([])
  })

  test("an old round that wakes up late does not free the round now going", async () => {
    const step = createWatchedStep(1000, () => {})
    const old = deferred<void>()
    let rounds = 0
    step(() => old.promise)
    jest.advanceTimersByTime(1000)
    await flush()

    step(() => {
      rounds++
      return new Promise(() => {})
    })
    await flush()
    old.resolve()
    await flush()
    step(async () => {
      rounds++
    })
    await flush()
    expect(rounds).toBe(1)
  })
})

describe("a stale lock", () => {
  const at = 1_793_582_382_401
  const id = `${at}-1a9f829b`

  test("is refused once the client may have given up", () => {
    expect(lockCameTooLate(id, at + LOCK_GRANT_WINDOW_MS + 1)).toBe(true)
    expect(lockCameTooLate(id, at + 120_000)).toBe(true)
  })

  test("is granted while the client is still reading receipts", () => {
    expect(lockCameTooLate(id, at)).toBe(false)
    expect(lockCameTooLate(id, at + LOCK_GRANT_WINDOW_MS)).toBe(false)
  })

  test("the window closes before the client's 10 s", () => {
    expect(LOCK_GRANT_WINDOW_MS).toBeLessThan(10_000)
  })

  test("reads the id of both scripts", () => {
    // PowerShell: Unix ms and a guid. sh: Unix seconds, 000 and the pid.
    expect(sentAt("1793582382401-1a9f829b")).toBe(1_793_582_382_401)
    expect(sentAt("1793582382000-4242")).toBe(1_793_582_382_000)
  })

  test("an id with no time in it is not called stale", () => {
    expect(sentAt("abc")).toBeUndefined()
    expect(sentAt("12-34")).toBeUndefined()
    expect(lockCameTooLate("abc", at)).toBe(false)
  })
})

/* `workbench.tsx` cannot be loaded under bun (Solid JSX), so its wiring is read from the source, as elsewhere here. */
describe("lint: the workbench's round waits for nothing slow", () => {
  const source = readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8")

  test("no delivery is awaited in the round: the lanes run them", () => {
    expect(source).not.toContain("await deliverOne(")
    expect(source).toContain("deliver: async (item) => {")
    expect(source).toContain("mailLanes.start(mailQueue)")
  })

  test("the timer and the native signal both only start a round", () => {
    expect(source).toContain("every(700, () => mailRound(false), { whenHidden: 700 })")
    expect(source).toContain("host?.onMailboxPending?.(mailRound)")
    const round = source.slice(source.indexOf("const mailRound = "), source.indexOf("onCleanup(every(700,"))
    expect(round).toContain("void deliverMail()")
    expect(round).not.toContain("return deliverMail()")
  })

  test("the three parts of a round have a watchdog each", () => {
    for (const part of ["takeStep(() => takeMail(host))", "moveStep(() => moveMail(host))", "watchStep(() => watchMail(host))"]) {
      expect(source).toContain(part)
    }
  })

  test("the voice's question is not awaited: it lasts as long as it takes to speak", () => {
    expect(source).not.toContain("await voiceEngine\n            .requestSendConfirmation")
    expect(source).toContain("void voiceEngine\n            .requestSendConfirmation")
  })

  test("a late lock is refused before the store is touched", () => {
    const refused = source.indexOf('message.op === "lock" && lockCameTooLate(id, Date.now())')
    const applied = source.indexOf("const result = applyKvAcross(")
    expect(refused).toBeGreaterThan(0)
    expect(applied).toBeGreaterThan(refused)
  })

  test("an answer does not overtake the delivery of its own request", () => {
    const gate = source.indexOf('"ref" in message && mailLanes.inFlight(message.ref)')
    const reply = source.indexOf('if (message.kind === "reply") {', gate)
    expect(gate).toBeGreaterThan(0)
    expect(reply).toBeGreaterThan(gate)
  })

  test("what is typed checks again after the await, so two parts of the round cannot both type", () => {
    expect(source).toContain("(await freeNow(host, item.paneId)) && !linesInFlight.has(item.paneId)")
    expect(source).toContain("!(await freeNow(host, target.pane.id)) || linesInFlight.has(target.pane.id)")
    expect(source).toContain("linesInFlight.track(paneId, deliverTextNow(")
  })
})

describe("what the sender reads", () => {
  // `ade-msg` exits 1 on anything that does not start with «ok».
  test("every outcome of giving up is an error to the client", () => {
    expect(lateLockReceipt("pc:ade-test")).toStartWith("errore: ")
    expect(hungReceipt("close", "r1", MAIL_LONG_MS)).toStartWith("errore: ")
    expect(failedReceipt(new Error("boom"))).toBe("errore: interno: boom")
    expect(failedReceipt("boom")).toBe("errore: interno: boom")
  })

  test("a hung step says it may still finish, so it is not simply repeated", () => {
    const receipt = hungReceipt("close", "r1", 900_000)
    expect(receipt).toContain("900 s")
    expect(receipt).toContain("controlla prima di ripeterlo")
  })

  test("a late lock names its key and says it was not taken", () => {
    const receipt = lateLockReceipt("pc:ade-test")
    expect(receipt).toContain("pc:ade-test")
    expect(receipt).toContain("non è stato preso")
  })
})

describe("dropFrom", () => {
  test("an item already gone leaves the others alone", () => {
    const list = ["a", "b"]
    expect(dropFrom(list, "gone")).toBe(false)
    expect(list).toEqual(["a", "b"])
    expect(dropFrom(list, "a")).toBe(true)
    expect(list).toEqual(["b"])
  })
})

describe("which lane and which deadline", () => {
  const base = { from: "p1", text: "" }
  const paneOf = (to: string) => (to === "1" ? "pane-1" : undefined)
  const kv: Message = { ...base, kind: "kv", op: "get", key: "k", ttl: 0, force: false }

  test("a kv and a who-owns collide with nothing", () => {
    expect(mailLane(kv, paneOf)).toBeUndefined()
    expect(mailLane({ ...base, kind: "whoowns" }, paneOf)).toBeUndefined()
  })

  test("typed mail goes by the pane it resolves to, however the sender named it", () => {
    expect(mailLane({ ...base, kind: "send", to: "1" }, paneOf)).toBe("pane:pane-1")
    expect(mailLane({ ...base, kind: "ask", to: "1" }, paneOf)).toBe("pane:pane-1")
    expect(mailLane({ ...base, kind: "send", to: "nobody" }, paneOf)).toBeUndefined()
  })

  test("an interrupt does not queue behind the mail held for that same turn", () => {
    const interrupt = mailLane({ ...base, kind: "interrupt", to: "1" }, paneOf)
    expect(interrupt).toBe("control:pane-1")
    expect(interrupt).not.toBe(mailLane({ ...base, kind: "send", to: "1" }, paneOf))
  })

  test("two answers to one request go one after the other", () => {
    const reply: Message = { ...base, kind: "reply", ref: "r1" }
    const cancel: Message = { ...base, kind: "cancel", ref: "r1" }
    expect(mailLane(reply, paneOf)).toBe("ref:r1")
    expect(mailLane(cancel, paneOf)).toBe("ref:r1")
    expect(mailLane({ ...base, kind: "reply", ref: "r2" }, paneOf)).toBe("ref:r2")
  })

  test("what reads and writes one file or one list goes one at a time", () => {
    expect(mailLane({ ...base, kind: "close", to: "1", force: false }, paneOf)).toBe("close")
    expect(mailLane({ ...base, kind: "memory", op: "show", type: "" }, paneOf)).toBe("memory")
    expect(mailLane({ ...base, kind: "registro", register: "decisioni", op: "open" }, paneOf)).toBe("registro")
    expect(mailLane({ ...base, kind: "design", path: "a.html" }, paneOf)).toBe("design")
  })

  test("the deadline leaves room for what the step may legitimately take", () => {
    expect(mailDeadline(kv)).toBe(MAIL_QUICK_MS)
    expect(mailDeadline({ ...base, kind: "send", to: "1" })).toBe(MAIL_STEP_MS)
    // `git worktree add` alone may take 600 s.
    expect(MAIL_LONG_MS).toBeGreaterThan(600_000)
    expect(mailDeadline({ ...base, kind: "close", to: "1", force: false })).toBe(MAIL_LONG_MS)
    expect(
      mailDeadline({ ...base, kind: "spawn", agent: "claude", autoClose: false, worktree: true, fork: false }),
    ).toBe(MAIL_LONG_MS)
  })
})
