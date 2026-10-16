import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { setLocalePreference } from "../i18n"
import type { AgentFile } from "./ragu"
import { createBotTurns } from "./controller"
import { forgetStoredKeys } from "./forget"
import { startGatewayController, type GatewayBridge, type GatewayMessage } from "./gateway/controller"
import { memorySessionStore } from "./gateway/session"
import { volatileMemoryStore, type MemoryStore } from "./memory"
import {
  addSpend,
  capText,
  memorySpendStore,
  noticeGiven,
  parseCap,
  parseSpendBook,
  SPEND_STORAGE_KEY,
  spendGate,
  spendNotice,
  spendStatus,
  spendTerms,
  spendTodayLine,
  withDailyCap,
  type SpendStore,
} from "./spend"
import { emptyTalk, type Talk } from "./talk"
import type { Turn, TurnRequest, TurnResult } from "./turn"

/*
 * The user's choice 5 (review of the bots, S8): a cap a day per bot, for its conversations by hand in ADE and from
 * a phone. Asked only of a bot that spends money (an API key, a paid model); counted per local day and kept with the
 * bot; a notice once a day at 80 %; at 100 % the bot does not start until tomorrow or until the cap is raised, and the
 * answer says how. No real model turn: fake turns report a cost.
 */

// 2026-10-16 at 10:00 and at 23:59 local time, then the next day at 00:01.
const MORNING = new Date(2026, 9, 16, 10, 0).getTime()
const LATE = new Date(2026, 9, 16, 23, 59).getTime()
const TOMORROW = new Date(2026, 9, 17, 0, 1).getTime()

const plain = (text: string | undefined) => (text ?? "").replace(/\s/g, " ")

afterEach(() => setLocalePreference("it"))

const BOT: AgentFile = {
  identifier: "contabile",
  path: "C:/u/.nikcli/agent/contabile.md",
  scope: "global",
  description: "",
  mode: "primary",
  prompt: "",
  disabledTools: [],
  runner: "claude",
}
const KEY = { mode: "key" as const, key: "lavoro" }

describe("whom the cap is asked of: the same «paid» as the routines", () => {
  test("a key or a paid model: money; a subscription or a free model: no cap; Codex with a key: not reported", () => {
    expect(spendTerms("claude", KEY, undefined)).toBe("money")
    expect(spendTerms("claude", { mode: "plan" }, undefined)).toBe("none")
    expect(spendTerms("claude", undefined, undefined)).toBe("none")
    expect(spendTerms("codex", KEY, undefined)).toBe("unreported")
    expect(spendTerms("codex", { mode: "plan" }, undefined)).toBe("none")
    expect(spendTerms("ragu", undefined, "openrouter/anthropic/claude-sonnet-4.5")).toBe("money")
    expect(spendTerms("ragu", undefined, "openrouter/x-ai/grok-4.1-fast:free")).toBe("none")
    // The catalog's word wins over the suffix, as for the routines.
    expect(spendTerms("ragu", undefined, "opencode/big-pickle", true)).toBe("none")
  })
})

describe("the day's count", () => {
  test("each turn's cost is summed for the local day, and starts again at midnight", () => {
    let spend = addSpend({ spentUsd: 0 }, 0.3, MORNING)
    spend = addSpend(spend, 0.12, LATE)
    expect(spend.spentUsd).toBeCloseTo(0.42)
    expect(addSpend(spend, 0.05, TOMORROW).spentUsd).toBeCloseTo(0.05)
    // A cost that is not one is not counted.
    expect(addSpend(spend, Number.NaN, LATE).spentUsd).toBeCloseTo(0.42)
    expect(addSpend(spend, -1, LATE).spentUsd).toBeCloseTo(0.42)
  })

  test("what was saved is read as far as it can be trusted", () => {
    const book = parseSpendBook(
      JSON.stringify({
        a: { capUsd: 2, day: "2026-10-16", spentUsd: 0.42, warnedDay: "2026-10-16" },
        b: { capUsd: -3, spentUsd: "molto" },
        c: 7,
      }),
    )
    expect(book["a"]).toEqual({ capUsd: 2, day: "2026-10-16", spentUsd: 0.42, warnedDay: "2026-10-16" })
    expect(book["b"]).toEqual({ spentUsd: 0 })
    expect(book["c"]).toEqual({ spentUsd: 0 })
    expect(parseSpendBook("{rotto")).toEqual({})
  })
})

describe("the gate before a turn", () => {
  test("no cap: the turn starts with nothing more to say", () => {
    expect(spendGate({ spentUsd: 5 }, MORNING)).toEqual({ ok: true })
  })

  test("under the cap: the turn may spend what is left of it", () => {
    const gate = spendGate({ capUsd: 2, day: "2026-10-16", spentUsd: 0.42 }, MORNING)
    expect(gate.ok).toBe(true)
    if (gate.ok) expect(gate.maxCostUsd).toBeCloseTo(1.58)
  })

  test("at the cap: no start until tomorrow, and the answer says how to raise it", () => {
    const gate = spendGate({ capUsd: 2, day: "2026-10-16", spentUsd: 2 }, MORNING, "contabile")
    expect(gate.ok).toBe(false)
    if (!gate.ok) {
      expect(plain(gate.problem)).toContain("2,00 $")
      expect(gate.problem).toContain("domani")
      expect(gate.problem).toContain("alza il tetto")
      expect(gate.problem).toContain("contabile")
    }
    // Tomorrow it starts again; so it does today once the cap is raised.
    expect(spendGate({ capUsd: 2, day: "2026-10-16", spentUsd: 2 }, TOMORROW).ok).toBe(true)
    expect(spendGate({ capUsd: 3, day: "2026-10-16", spentUsd: 2 }, MORNING).ok).toBe(true)
  })
})

describe("the notice at 80 %, once a day", () => {
  test("said when the day's spend reaches 80 % of the cap, then not again until tomorrow", () => {
    const under = { capUsd: 2, day: "2026-10-16", spentUsd: 1.5 }
    expect(spendNotice(under, MORNING)).toBeUndefined()
    const over = addSpend(under, 0.12, MORNING)
    const notice = spendNotice(over, MORNING)
    expect(plain(notice)).toContain("1,62 $")
    expect(plain(notice)).toContain("2,00 $")
    expect(notice).toContain("80")
    const told = noticeGiven(over, MORNING)
    expect(spendNotice(addSpend(told, 0.1, LATE), LATE)).toBeUndefined()
    // Tomorrow's 80 % is said again.
    expect(spendNotice(addSpend(told, 1.7, TOMORROW), TOMORROW)).toBeDefined()
  })

  test("no cap, no notice", () => {
    expect(spendNotice({ spentUsd: 100, day: "2026-10-16" }, MORNING)).toBeUndefined()
  })
})

describe("/stato and the line «Spesa di oggi»", () => {
  test("«Oggi 0,42 $ di 2,00 $», in each language", () => {
    const spend = { capUsd: 2, day: "2026-10-16", spentUsd: 0.42 }
    expect(plain(spendStatus(spend, "money", MORNING))).toBe("Oggi 0,42 $ di 2,00 $.")
    setLocalePreference("en")
    expect(plain(spendStatus(spend, "money", MORNING))).toBe("Today $0.42 of $2.00.")
  })

  test("no cap set, a new day, a subscription, Codex with a key", () => {
    expect(plain(spendStatus({ day: "2026-10-16", spentUsd: 0.42 }, "money", MORNING))).toBe(
      "Oggi 0,42 $, senza tetto.",
    )
    expect(plain(spendStatus({ capUsd: 2, day: "2026-10-16", spentUsd: 0.42 }, "money", TOMORROW))).toBe(
      "Oggi 0,00 $ di 2,00 $.",
    )
    expect(spendStatus({ capUsd: 2, spentUsd: 0.42 }, "none", MORNING)).toBeUndefined()
    expect(spendStatus({ spentUsd: 0 }, "unreported", MORNING)).toContain("Codex")
  })
})

describe("the line «Spesa di oggi» of the bot's Impostazioni", () => {
  test("the day's spend and the cap; stopped once it is spent; nothing for a subscription", () => {
    const spend = { capUsd: 2, day: "2026-10-16", spentUsd: 0.42 }
    expect(plain(spendTodayLine(spend, "money", MORNING))).toBe("Spesa di oggi: 0,42 $ di 2,00 $")
    expect(spendTodayLine({ ...spend, spentUsd: 2 }, "money", MORNING)).toContain("fermo fino a domani")
    expect(plain(spendTodayLine({ spentUsd: 0 }, "money", MORNING))).toBe("Spesa di oggi: 0,00 $, senza tetto")
    expect(spendTodayLine(spend, "none", MORNING)).toBeUndefined()
  })

  test("the field shows the saved cap in the language's way", () => {
    expect(capText(2.5)).toBe("2,5")
    expect(capText(undefined)).toBe("")
    setLocalePreference("en")
    expect(capText(2.5)).toBe("2.5")
  })
})

describe("the cap field", () => {
  test("dollars with a comma or a point; empty is no cap; zero, words and too much are refused", () => {
    expect(parseCap("2")).toEqual({ ok: true, capUsd: 2 })
    expect(parseCap(" 2,5 ")).toEqual({ ok: true, capUsd: 2.5 })
    expect(parseCap("0.75")).toEqual({ ok: true, capUsd: 0.75 })
    expect(parseCap("")).toEqual({ ok: true })
    for (const wrong of ["0", "-1", "due", "1e9", "2,5,1"]) expect([wrong, parseCap(wrong).ok]).toEqual([wrong, false])
  })
})

/* ── the turns ─────────────────────────────────────────────────────────── */

/** Turns that end when the test says so, reporting a cost. */
function fakeTurns() {
  const started: { request: TurnRequest; finish: (result: Partial<TurnResult>) => void }[] = []
  const runTurn = (request: TurnRequest): Turn => {
    let resolve!: (result: TurnResult) => void
    const result = new Promise<TurnResult>((done) => (resolve = done))
    const entry = {
      request,
      finish: (partial: Partial<TurnResult>) =>
        resolve({ status: "done", text: "", tokens: 0, costUsd: 0, talk: emptyTalk(), ...partial }),
    }
    started.push(entry)
    return { result, stop: () => entry.finish({ status: "stopped" }) }
  }
  return { started, runTurn }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function capped(store: SpendStore, capUsd: number, spentUsd = 0) {
  store.set(BOT.path, { capUsd, day: "2026-10-16", spentUsd })
}

describe("a turn from a chat (`withDailyCap`, the gateway's runTurn)", () => {
  const request = (account = KEY): TurnRequest => ({ runner: "claude", bot: BOT, message: "ciao", account })

  test("a subscription runs as before: no cap passed, nothing counted", async () => {
    const store = memorySpendStore()
    capped(store, 2)
    const turns = fakeTurns()
    const run = withDailyCap(turns.runTurn, { store, now: () => MORNING })
    const turn = run(request({ mode: "plan" } as never))
    expect(turns.started[0]!.request.maxCostUsd).toBeUndefined()
    turns.started[0]!.finish({ costUsd: 1.9, text: "fatto" })
    expect((await turn.result).text).toBe("fatto")
    expect(store.get(BOT.path).spentUsd).toBe(0)
  })

  test("with a key: the turn may spend what is left, and its cost is counted", async () => {
    const store = memorySpendStore()
    capped(store, 2, 0.42)
    const turns = fakeTurns()
    const turn = withDailyCap(turns.runTurn, { store, now: () => MORNING })(request())
    expect(turns.started[0]!.request.maxCostUsd).toBeCloseTo(1.58)
    turns.started[0]!.finish({ costUsd: 0.3, text: "fatto" })
    expect((await turn.result).text).toBe("fatto")
    expect(store.get(BOT.path).spentUsd).toBeCloseTo(0.72)
  })

  test("the turn that reaches 80 % says so in the chat and in the thread ADE keeps, once a day", async () => {
    const store = memorySpendStore()
    capped(store, 2, 1.5)
    const turns = fakeTurns()
    const run = withDailyCap(turns.runTurn, { store, now: () => MORNING })
    const first = run(request())
    turns.started[0]!.finish({ costUsd: 0.12, text: "fatto" })
    const said = await first.result
    expect(said.text.startsWith("fatto")).toBe(true)
    expect(plain(said.text)).toContain("1,62 $")
    expect(said.talk.messages.at(-1)).toMatchObject({ role: "tool", tool: "ade" })
    const second = run(request())
    turns.started[1]!.finish({ costUsd: 0.1, text: "ancora" })
    expect((await second.result).text).toBe("ancora")
  })

  test("a failed turn that reaches 80 % leaves the notice to the next answer", async () => {
    const store = memorySpendStore()
    capped(store, 2, 1.5)
    const turns = fakeTurns()
    const run = withDailyCap(turns.runTurn, { store, now: () => MORNING })
    const failed = run(request())
    turns.started[0]!.finish({ status: "error", costUsd: 0.12, problem: "rete" })
    expect((await failed.result).status).toBe("error")
    const next = run(request())
    turns.started[1]!.finish({ costUsd: 0.01, text: "eccomi" })
    expect(plain((await next.result).text)).toContain("2,00 $")
  })

  test("at 100 %: nothing starts, and the chat reads how to raise the cap", async () => {
    const store = memorySpendStore()
    capped(store, 2, 2.05)
    const turns = fakeTurns()
    const result = await withDailyCap(turns.runTurn, { store, now: () => MORNING })(request()).result
    expect(turns.started).toHaveLength(0)
    // «done» with the reason as the answer: the gateway sends a failure as a fixed text, and this one must be read.
    expect(result.status).toBe("done")
    expect(result.text).toContain("alza il tetto")
    expect(result.costUsd).toBe(0)
    expect(result.talk.messages.map((message) => message.role)).toEqual(["user", "error"])
  })

  test("a request with its own smaller cap keeps it", () => {
    const store = memorySpendStore()
    capped(store, 2)
    const turns = fakeTurns()
    withDailyCap(turns.runTurn, { store, now: () => MORNING })({ ...request(), maxCostUsd: 0.1 })
    expect(turns.started[0]!.request.maxCostUsd).toBe(0.1)
  })
})

describe("a conversation by hand in ADE (`createBotTurns`)", () => {
  function panel(store: SpendStore, account: { mode: "plan" } | typeof KEY = KEY, memory?: MemoryStore) {
    const talks: Record<string, Talk> = {}
    const fake = fakeTurns()
    const routines: TurnRequest[] = []
    const turns = createBotTurns({
      runTurn: fake.runTurn,
      runRoutine: (request) => {
        routines.push(request)
        return fake.runTurn(request)
      },
      talkOf: (path) => talks[path] ?? emptyTalk(),
      update: (path, change) => void (talks[path] = change(talks[path] ?? emptyTalk())),
      accountOf: () => account,
      always: { get: () => [], add: () => {}, remove: () => {}, clear: () => {} },
      spend: store,
      ...(memory ? { memory } : {}),
      now: () => MORNING,
    })
    return { turns, fake, talks, routines }
  }

  test("a turn the cap refuses leaves what the bot's memory has to tell it for the next one", async () => {
    const store = memorySpendStore()
    capped(store, 2, 2)
    const memory = volatileMemoryStore()
    memory.set(BOT.path, { notes: [], user: [], pending: ["una scrittura non riuscita"] })
    panel(store, KEY, memory).turns.send(BOT, "ciao")
    await tick()
    expect(memory.get(BOT.path).pending).toEqual(["una scrittura non riuscita"])
  })

  test("the turn may spend what is left of the cap, and its cost is counted when it ends", async () => {
    const store = memorySpendStore()
    capped(store, 2, 0.42)
    const p = panel(store)
    expect(p.turns.send(BOT, "ciao")).toBe(true)
    expect(p.fake.started[0]!.request.maxCostUsd).toBeCloseTo(1.58)
    p.fake.started[0]!.finish({ costUsd: 0.2 })
    await tick()
    expect(store.get(BOT.path).spentUsd).toBeCloseTo(0.62)
  })

  test("the notice at 80 % goes into the bot's conversation, once", async () => {
    const store = memorySpendStore()
    capped(store, 2, 1.5)
    const p = panel(store)
    p.turns.send(BOT, "ciao")
    p.fake.started[0]!.finish({ costUsd: 0.2 })
    await tick()
    const notices = () =>
      p.talks[BOT.path]!.messages.filter((m) => m.role === "tool" && plain(m.text).includes("2,00 $"))
    expect(notices()).toHaveLength(1)
    p.turns.send(BOT, "ancora")
    p.fake.started[1]!.finish({ costUsd: 0.05 })
    await tick()
    expect(notices()).toHaveLength(1)
  })

  test("a turn stopped half way still counts what it spent", async () => {
    const store = memorySpendStore()
    capped(store, 2)
    const p = panel(store)
    p.turns.send(BOT, "ciao")
    p.fake.started[0]!.finish({ status: "stopped", costUsd: 0.3 })
    await tick()
    expect(store.get(BOT.path).spentUsd).toBeCloseTo(0.3)
  })

  test("at 100 %: the bot does not start, and the thread says why and how to raise the cap", async () => {
    const store = memorySpendStore()
    capped(store, 2, 2)
    const p = panel(store)
    p.turns.send(BOT, "ciao")
    expect(p.fake.started).toHaveLength(0)
    await tick()
    // As any turn that does not run: the thread's problem, under the user's message.
    const talk = p.talks[BOT.path]!
    expect(talk.messages.at(-1)).toMatchObject({ role: "user", text: "ciao" })
    expect(talk.status).toBe("error")
    expect(talk.problem).toContain("alza il tetto")
    expect(p.turns.running(BOT.path)).toBe(false)
  })

  test("a subscription is not capped nor counted", async () => {
    const store = memorySpendStore()
    capped(store, 2, 2)
    const p = panel(store, { mode: "plan" })
    p.turns.send(BOT, "ciao")
    expect(p.fake.started).toHaveLength(1)
    expect(p.fake.started[0]!.request.maxCostUsd).toBeUndefined()
    p.fake.started[0]!.finish({ costUsd: 1 })
    await tick()
    expect(store.get(BOT.path).spentUsd).toBe(2)
  })

  test("routines and rooms keep their own caps: not stopped by this one, not counted in it", async () => {
    const store = memorySpendStore()
    capped(store, 2, 2)
    const p = panel(store)
    p.turns.routine(BOT, "controlla", undefined, { maxCostUsd: 0.1 })
    expect(p.routines).toHaveLength(1)
    expect(p.routines[0]!.maxCostUsd).toBe(0.1)
    p.fake.started[0]!.finish({ costUsd: 0.05 })
    await tick()
    p.turns.room(BOT, "ciao", "stanza", undefined, 0.2)
    expect(p.fake.started[1]!.request.maxCostUsd).toBe(0.2)
    p.fake.started[1]!.finish({ costUsd: 0.05 })
    await tick()
    expect(store.get(BOT.path).spentUsd).toBe(2)
  })
})

describe("/stato from the phone", () => {
  test("says the day's spend too", async () => {
    let handler: ((message: GatewayMessage) => void) | undefined
    const sent: string[] = []
    const fake: GatewayBridge = {
      listen: async (on) => {
        handler = on
        return () => {}
      },
      ready: async () => {},
      send: async (_bot, _platform, _chat, text) => {
        sent.push(text)
        return "1"
      },
      sendButtons: async () => "q",
      typing: async () => {},
      project: async () => "C:/progetto",
    }
    const controller = await startGatewayController({
      bridge: fake,
      runTurn: fakeTurns().runTurn,
      loadBot: async () => ({ ok: true as const, bot: BOT }),
      sessions: memorySessionStore(),
      spendToday: async (bot) => (bot === BOT.path ? "Oggi 0,42 $ di 2,00 $." : undefined),
    })
    handler?.({
      bot: BOT.path,
      platform: "telegram",
      chat: "c1",
      sender: { id: "1", name: "Ale" },
      text: "/stato",
      id: "m1",
      redacted: false,
      button: false,
      private: true,
    })
    for (let i = 0; i < 100 && sent.length === 0; i++) await tick()
    expect(sent[0]).toContain("Oggi 0,42 $ di 2,00 $.")
    controller.stop()
  })
})

describe("kept with the bot", () => {
  test("deleting the bot takes its count and its cap away", () => {
    const saved: Record<string, string> = {
      [SPEND_STORAGE_KEY]: JSON.stringify({ [BOT.path]: { capUsd: 2, spentUsd: 1 }, "C:/altro.md": { spentUsd: 3 } }),
    }
    const storage = {
      get length() {
        return Object.keys(saved).length
      },
      key: (index: number) => Object.keys(saved)[index] ?? null,
      getItem: (key: string) => saved[key] ?? null,
      setItem: (key: string, value: string) => void (saved[key] = value),
      removeItem: (key: string) => void delete saved[key],
    }
    forgetStoredKeys(BOT.path, storage)
    expect(Object.keys(JSON.parse(saved[SPEND_STORAGE_KEY]!))).toEqual(["C:/altro.md"])
  })

  test("the app wires it: the gateway's turns go through the cap, and /stato reads it", () => {
    const bridge = readFileSync(new URL("./gateway/bridge.ts", import.meta.url), "utf8")
    expect(bridge).toContain("runTurn: withDailyCap((request) => runBotTurn(request)")
    expect(bridge).toContain("spendToday:")
  })

  test("the pieces for the bot's Impostazioni are ready, and bots.tsx is not touched", () => {
    const pieces = readFileSync(new URL("./spend-panel.tsx", import.meta.url), "utf8")
    expect(pieces).toContain("export function SpendCapField")
    expect(pieces).toContain("export function SpendTodayLine")
    expect(pieces).toContain("parseCap(")
    expect(pieces).toContain("spendTerms(")
    const bots = readFileSync(new URL("./bots.tsx", import.meta.url), "utf8")
    expect(bots).not.toContain("spend-panel")
  })
})
