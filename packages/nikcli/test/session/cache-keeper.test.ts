import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { writeFileSync } from "node:fs"
import { Runtime } from "@nikcli-ai/llm"
import type { LLMRequest } from "@nikcli-ai/llm"
import { AnthropicMessages, OpenAIResponses } from "@nikcli-ai/llm/protocols"
import type { ModelMessage } from "@/session/llm/types"
import { LLM } from "@/session/llm"
import { CacheKeeper } from "@/session/cache-keeper"

/**
 * The cache keeper against a fake provider and a clock the test turns by hand, with lifetimes of seconds. What is real is the request
 * (built the way a turn builds it) and its wire body (`prepareRequest`): the byte-for-byte claim is made on that.
 */

const anthropic = AnthropicMessages.model({
  id: "claude-sonnet-4-5",
  baseURL: "https://api.anthropic.test/v1/",
  headers: { "x-api-key": "test" },
})
const openai = OpenAIResponses.model({
  id: "gpt-5.6",
  baseURL: "https://api.openai.test/v1/",
  headers: { authorization: "Bearer test" },
})

const user = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: [{ type: "text", text }] })
const realRequest = (model: typeof anthropic) =>
  LLM.buildLLMRequest(
    {
      system: ["You are the agent.", "Project instructions."],
      messages: [user("read the repository"), assistant("done, here is the summary"), user("now fix the failing test")],
      tools: {},
    },
    model,
    { maxOutputTokens: 4096, temperature: 0 },
  )

const BIG: CacheKeeper.Usage = { input: 40, output: 300, cacheRead: 30_000, cacheWrite: 2_000 }
const READ: CacheKeeper.Usage = { input: 30, output: 1, cacheRead: 32_000, cacheWrite: 0 }
/** A keep-alive that finds the entry gone: it reads nothing and writes the prefix again at full price. */
const MISS: CacheKeeper.Usage = { input: 20, output: 1, cacheRead: 0, cacheWrite: 31_000 }

interface Sent {
  request: LLMRequest
  signal: AbortSignal
  at: number
}

/** A fake world: a clock, a provider that records what it is sent, and the gates a session answers. */
function world(settings: Partial<CacheKeeper.Settings> = {}) {
  let now = 1_000_000
  const timers: { id: number; at: number; run: () => void }[] = []
  let next = 1
  const sent: Sent[] = []
  const events: { sessionID: string; state: string; renewals: number; reason?: string; expiresAt?: number }[] = []
  const state = {
    quiet: true,
    attached: 1,
    answers: [] as (CacheKeeper.Usage | Error | "hang")[],
    /** Answers of the next `quiet` calls, before `quiet` itself. */
    quietSeq: [] as boolean[],
    /** Holds every `quiet` call until it resolves. */
    gate: undefined as Promise<void> | undefined,
    compacted: [] as string[],
    compactFails: undefined as Error | undefined,
    pending: [] as ((usage: CacheKeeper.Usage | undefined) => void)[],
    settings: {
      enabled: true,
      lifetimeS: 20,
      marginPct: 10,
      minTokens: 20_000,
      maxRenewals: undefined as number | undefined,
      horizonS: undefined as number | undefined,
      compact: false,
      ...settings,
    } as CacheKeeper.Settings,
  }
  const deps: CacheKeeper.Deps = {
    now: () => now,
    setTimer: (run, ms) => {
      const id = next++
      timers.push({ id, at: now + ms, run })
      return id
    },
    clearTimer: (handle) => {
      const at = timers.findIndex((timer) => timer.id === handle)
      if (at >= 0) timers.splice(at, 1)
    },
    prepare: (request) => Runtime.prepareRequest(request),
    send: (request, _fetch, signal) => {
      sent.push({ request, signal, at: now })
      const answer = state.answers.shift() ?? READ
      if (answer instanceof Error) return Promise.reject(answer)
      if (answer === "hang") return new Promise((resolve) => state.pending.push(resolve))
      return Promise.resolve(answer)
    },
    compact: async (sessionID) => {
      state.compacted.push(sessionID)
      if (state.compactFails) throw state.compactFails
    },
    quiet: async () => {
      if (state.gate) await state.gate
      return state.quietSeq.length > 0 ? state.quietSeq.shift()! : state.quiet
    },
    attached: () => state.attached,
    publish: (event) => void events.push(event),
    settings: () => state.settings,
  }
  const flush = async () => {
    // Microtasks only: nothing the keeper does waits on the event loop, and a real tick costs 15 ms on Windows.
    for (let i = 0; i < 40; i++) await Promise.resolve()
  }
  return {
    deps,
    state,
    sent,
    events,
    timers: () => timers.length,
    /** Turn the clock `ms` forward, running every timer that falls due on the way, in order. */
    async advance(ms: number) {
      const to = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const due = timers[0]
        if (!due || due.at > to) break
        timers.shift()
        now = Math.max(now, due.at)
        due.run()
        await flush()
      }
      now = to
      await flush()
    },
    now: () => now,
    flush,
  }
}

const body = async (request: LLMRequest) => (await Runtime.prepareRequest(request)).body as Record<string, unknown>

let w: ReturnType<typeof world>
const SESSION = "ses_keeper_1"

/** A real turn: the request goes out, and its answer arms the keeper. */
async function turn(request: LLMRequest, usage: CacheKeeper.Usage = BIG, session = SESSION) {
  CacheKeeper.observe({ sessionID: session, request, fetch: undefined })
  await CacheKeeper.used(session, usage)
}

beforeEach(() => {
  w = world()
  CacheKeeper.useDeps(w.deps)
})
afterEach(() => CacheKeeper.useDeps(undefined))

describe("the hidden request", () => {
  it("has the prefix of the last real request byte for byte, and only its output cap differs", async () => {
    const real = realRequest(anthropic)
    await turn(real)
    await w.advance(18_000)
    expect(w.sent).toHaveLength(1)
    const hidden = w.sent[0]!.request
    const realBody = await body(real)
    const hiddenBody = await body(hidden)
    // The dump the report asks for: both bodies, as the provider would receive them.
    if (process.env["KEEPER_DUMP"]) {
      writeFileSync(process.env["KEEPER_DUMP"], JSON.stringify({ real: realBody, hidden: hiddenBody }, null, 2))
    }
    expect(JSON.stringify(CacheKeeper.prefixOf(hiddenBody))).toBe(JSON.stringify(CacheKeeper.prefixOf(realBody)))
    // Tools, system and messages: the three parts of the prefix, each compared on its own as well.
    for (const part of ["system", "messages", "tools"]) expect(JSON.stringify(hiddenBody[part])).toBe(JSON.stringify(realBody[part]))
    expect(realBody["max_tokens"]).toBe(4096)
    expect(hiddenBody["max_tokens"]).toBe(1)
    // The breakpoints are still on the last blocks: that is what the read refreshes.
    expect(JSON.stringify(hiddenBody)).toContain('"cache_control":{"type":"ephemeral"}')
  })

  it("is the real request itself: nothing is added to the conversation", async () => {
    const real = realRequest(anthropic)
    await turn(real)
    await w.advance(18_000)
    const hidden = w.sent[0]!.request
    expect(hidden.messages).toEqual(real.messages)
    expect(hidden.system).toEqual(real.system)
    expect(hidden.tools).toEqual(real.tools)
    expect(hidden.messages).toHaveLength(3)
    expect(hidden.toolChoice).toEqual(real.toolChoice)
  })

  it("on the Responses route the cap is 16, the least the API takes", async () => {
    w.state.settings = { ...w.state.settings, lifetimeS: 20 }
    const real = realRequest(openai)
    await turn(real)
    await w.advance(18_000)
    const hiddenBody = await body(w.sent[0]!.request)
    expect(hiddenBody["max_output_tokens"]).toBe(16)
    expect(JSON.stringify(CacheKeeper.prefixOf(hiddenBody))).toBe(JSON.stringify(CacheKeeper.prefixOf(await body(real))))
  })
})

describe("when it fires", () => {
  it("shortly before the entry would expire: with a 20 s lifetime and a 10% margin, at 18 s", async () => {
    await turn(realRequest(anthropic))
    expect(w.events.at(-1)).toMatchObject({ state: "armed", renewals: 0, expiresAt: w.now() + 20_000 })
    await w.advance(17_900)
    expect(w.sent).toHaveLength(0)
    await w.advance(100)
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.at).toBe(1_000_000 + 18_000)
  })

  it("renews from the moment it sent, and fires again 18 s later", async () => {
    await turn(realRequest(anthropic))
    await w.advance(18_000)
    expect(w.events.at(-1)).toMatchObject({ state: "renewed", renewals: 1, expiresAt: 1_000_000 + 18_000 + 20_000 })
    await w.advance(17_900)
    expect(w.sent).toHaveLength(1)
    await w.advance(100)
    expect(w.sent).toHaveLength(2)
  })

  it("reads the lifetime off the wire: the 5 minutes by default, the hour when the body asks for it", async () => {
    w.state.settings = { ...w.state.settings, lifetimeS: undefined }
    await turn(realRequest(anthropic))
    expect(w.events.at(-1)?.expiresAt).toBe(w.now() + 300_000)
    expect(CacheKeeper.anthropicLifetimeS({ system: [{ cache_control: { type: "ephemeral", ttl: "1h" } }] })).toBe(3_600)
    expect(CacheKeeper.anthropicLifetimeS({ system: [{ cache_control: { type: "ephemeral" } }] })).toBe(300)
    process.env["NIKCLI_CACHE_RETENTION"] = "long"
    try {
      const long = realRequest(anthropic)
      CacheKeeper.useDeps(w.deps)
      await turn(long)
      expect(w.events.at(-1)?.expiresAt).toBe(w.now() + 3_600_000)
    } finally {
      delete process.env["NIKCLI_CACHE_RETENTION"]
    }
  })

  it("OpenAI has no lifetime to read: with none configured the keeper is off for it", async () => {
    w.state.settings = { ...w.state.settings, lifetimeS: undefined }
    await turn(realRequest(openai))
    expect(w.timers()).toBe(0)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped", reason: "no lifetime known for this provider" })
  })
})

describe("when it stops", () => {
  it("at the budget: after N renewals, never one more", async () => {
    w.state.settings = { ...w.state.settings, maxRenewals: 3 }
    await turn(realRequest(anthropic))
    await w.advance(10 * 60_000)
    expect(w.sent).toHaveLength(3)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped", reason: "budget spent", renewals: 3 })
    expect(w.timers()).toBe(0)
  })

  it("by default at the break-even of the provider: write price over read price", async () => {
    expect(CacheKeeper.breakEven("anthropic-messages", 3_600)).toBe(20)
    expect(CacheKeeper.breakEven("anthropic-messages", 300)).toBe(12)
    expect(CacheKeeper.breakEven("openai-responses", 600)).toBe(10)
    await turn(realRequest(anthropic))
    await w.advance(60 * 60_000)
    // A 20 s lifetime is a short entry: 12 renewals.
    expect(w.sent).toHaveLength(12)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped", reason: "budget spent" })
  })

  it("idle compaction off: the budget ends in a stop and nothing is compacted", async () => {
    await turn(realRequest(anthropic))
    await w.advance(60 * 60_000)
    expect(w.state.compacted).toEqual([])
  })

  it("idle compaction on: at the end of the budget the session is compacted once, then the keeper is done", async () => {
    w.state.settings = { ...w.state.settings, compact: true }
    await turn(realRequest(anthropic))
    await w.advance(60 * 60_000)
    expect(w.sent).toHaveLength(12)
    expect(w.state.compacted).toEqual([SESSION])
    expect(w.events.at(-1)).toMatchObject({ state: "compacted", reason: "budget spent" })
    expect(w.events.filter((e) => e.state === "stopped")).toHaveLength(0)
    expect(w.timers()).toBe(0)
  })

  it("a budget of 0 with the compaction on: no keep-alive, and the compaction waits for the margin before the entry expires", async () => {
    w.state.settings = { ...w.state.settings, compact: true, maxRenewals: 0 }
    await turn(realRequest(anthropic))
    // Not at the end of the turn: the entry is warm for the whole lifetime (20 s), and it is that warmth the compaction reads.
    expect(w.state.compacted).toEqual([])
    expect(w.timers()).toBe(1)
    await w.advance(17_000)
    expect(w.state.compacted).toEqual([])
    // The margin is 10 % of the lifetime: 18 s.
    await w.advance(1_500)
    expect(w.state.compacted).toEqual([SESSION])
    expect(w.sent).toHaveLength(0)
    expect(w.events.at(-1)).toMatchObject({ state: "compacted", reason: "budget spent" })
  })

  it("a horizon reached after a renewal with the compaction on waits for the margin of the renewed entry too", async () => {
    w.state.settings = { ...w.state.settings, compact: true, horizonS: 1 }
    await turn(realRequest(anthropic))
    // The first keep-alive at 18 s; the horizon (1 s) is spent by then, and the renewed entry lives until 38 s.
    await w.advance(20_000)
    expect(w.sent).toHaveLength(1)
    expect(w.state.compacted).toEqual([])
    await w.advance(17_000)
    expect(w.state.compacted).toEqual([SESSION])
    expect(w.sent).toHaveLength(1)
  })

  it("idle compaction on, but a turn is running at the end of the budget: stop, never compact over a turn", async () => {
    w.state.settings = { ...w.state.settings, compact: true, maxRenewals: 1 }
    await turn(realRequest(anthropic))
    // Idle when the keep-alive fires, busy by the time the budget is spent.
    w.state.quietSeq = [true, false]
    await w.advance(60_000)
    expect(w.sent).toHaveLength(1)
    expect(w.state.compacted).toEqual([])
    expect(w.events.at(-1)).toMatchObject({ state: "stopped" })
  })

  it("a failed idle compaction is a log line and a stop, never an error of a turn", async () => {
    w.state.settings = { ...w.state.settings, compact: true }
    w.state.compactFails = new Error("boom")
    await turn(realRequest(anthropic))
    await w.advance(60 * 60_000)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped", reason: "the idle compaction failed" })
  })

  it("a thinking budget: Anthropic rejects an output cap of 1 below it, so the keeper stops with that reason and sends nothing", async () => {
    const request = LLM.buildLLMRequest(
      { system: ["You are the agent."], messages: [user("hello")], tools: {} },
      anthropic,
      { maxOutputTokens: 32000, providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 16000 } } } as never },
    )
    expect(CacheKeeper.thinkingBudget(request)).toBe(16000)
    await turn(request)
    await w.advance(10 * 60_000)
    expect(w.sent).toHaveLength(0)
    expect(w.timers()).toBe(0)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped" })
    expect(w.events.at(-1)?.reason).toContain("thinking with a budget")
    // Adaptive thinking and no thinking are not budgets.
    expect(CacheKeeper.thinkingBudget(realRequest(anthropic))).toBeUndefined()
  })

  it("release (a deleted session): the timer is gone and nothing is sent", async () => {
    await turn(realRequest(anthropic))
    expect(w.timers()).toBe(1)
    CacheKeeper.release(SESSION)
    expect(w.timers()).toBe(0)
    await w.advance(10 * 60_000)
    expect(w.sent).toHaveLength(0)
  })

  it("release while the keeper is checking the session: the request is not sent", async () => {
    await turn(realRequest(anthropic))
    let open!: () => void
    w.state.gate = new Promise<void>((resolve) => (open = resolve))
    await w.advance(18_000)
    CacheKeeper.release(SESSION)
    open()
    await w.flush()
    expect(w.sent).toHaveLength(0)
  })

  it("releaseInstance: the sessions of a disposed instance end, the others go on", async () => {
    const mine = {}
    const other = {}
    CacheKeeper.observe({ sessionID: "ses_a", request: realRequest(anthropic), fetch: undefined, ctx: mine })
    await CacheKeeper.used("ses_a", BIG)
    CacheKeeper.observe({ sessionID: "ses_b", request: realRequest(anthropic), fetch: undefined, ctx: other })
    await CacheKeeper.used("ses_b", BIG)
    expect(w.timers()).toBe(2)
    CacheKeeper.releaseInstance(mine)
    expect(w.timers()).toBe(1)
    await w.advance(18_000)
    expect(w.sent).toHaveLength(1)
  })

  it("at the horizon, whatever the renewals", async () => {
    w.state.settings = { ...w.state.settings, horizonS: 50 }
    await turn(realRequest(anthropic))
    await w.advance(10 * 60_000)
    expect(w.sent.length).toBeGreaterThan(0)
    expect(w.sent.length).toBeLessThan(4)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped", reason: "horizon reached" })
  })

  it("below the size threshold: a rewrite is cheap, so nothing is kept", async () => {
    await turn(realRequest(anthropic), { input: 10, output: 5, cacheRead: 0, cacheWrite: 3_000 })
    expect(w.timers()).toBe(0)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped", reason: "prefix below the threshold" })
  })

  it("when the provider reported no cached tokens: there is no entry to keep", async () => {
    await turn(realRequest(anthropic), { input: 50_000, output: 5, cacheRead: 0, cacheWrite: 0 })
    expect(w.timers()).toBe(0)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped" })
    expect(w.events.at(-1)?.reason).toContain("no cache entry")
  })

  it("a keep-alive that finds the entry gone (it rewrote it) counts as a renewal and the keeper goes on", async () => {
    w.state.answers = [MISS]
    await turn(realRequest(anthropic))
    await w.advance(18_000)
    expect(w.sent).toHaveLength(1)
    expect(w.events.at(-1)).toMatchObject({ state: "renewed", renewals: 1 })
    expect(w.timers()).toBe(1)
    // The next one is timed from the miss, which wrote the entry again: 18 s later.
    await w.advance(18_000)
    expect(w.sent).toHaveLength(2)
    expect(w.sent[1]!.at - w.sent[0]!.at).toBe(18_000)
  })

  it("hit, miss, hit: the keeper goes on, and the miss in the middle does not count against it", async () => {
    w.state.answers = [READ, MISS, READ]
    await turn(realRequest(anthropic))
    await w.advance(18_000 * 3)
    expect(w.sent).toHaveLength(3)
    expect(w.events.filter((event) => event.state === "stopped")).toEqual([])
    expect(w.events.at(-1)).toMatchObject({ state: "renewed", renewals: 3 })
    expect(w.timers()).toBe(1)
  })

  it("miss, miss: two in a row stop it, whatever the budget", async () => {
    w.state.answers = [MISS, MISS]
    await turn(realRequest(anthropic))
    await w.advance(60 * 60_000)
    expect(w.sent).toHaveLength(2)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped", reason: "two misses in a row", renewals: 2 })
    expect(w.timers()).toBe(0)
  })

  it("a hit between two misses starts the count again", async () => {
    w.state.answers = [MISS, READ, MISS, READ]
    await turn(realRequest(anthropic))
    await w.advance(18_000 * 4)
    expect(w.sent).toHaveLength(4)
    expect(w.events.filter((event) => event.state === "stopped")).toEqual([])
  })

  it("a miss uses the budget like a hit: with a budget of 2, hit then miss ends in `budget spent`", async () => {
    w.state.settings = { ...w.state.settings, maxRenewals: 2 }
    w.state.answers = [READ, MISS]
    await turn(realRequest(anthropic))
    await w.advance(10 * 60_000)
    expect(w.sent).toHaveLength(2)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped", reason: "budget spent", renewals: 2 })
  })

  it("a miss without cache writes (OpenAI reports none) is the same: it counts, and two in a row stop", async () => {
    w.state.settings = { ...w.state.settings, lifetimeS: 20 }
    const silent: CacheKeeper.Usage = { input: 31_000, output: 16, cacheRead: 0, cacheWrite: 0 }
    w.state.answers = [silent, silent]
    await turn(realRequest(openai), { input: 40, output: 300, cacheRead: 30_000, cacheWrite: 0 })
    await w.advance(60 * 60_000)
    expect(w.sent).toHaveLength(2)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped", reason: "two misses in a row" })
  })

  it("a real turn in the middle starts everything again: the misses, the renewals and the budget", async () => {
    w.state.answers = [MISS]
    await turn(realRequest(anthropic))
    await w.advance(18_000)
    expect(w.events.at(-1)).toMatchObject({ renewals: 1 })
    w.state.answers = [MISS]
    await turn(realRequest(anthropic))
    expect(w.events.at(-1)).toMatchObject({ state: "armed", renewals: 0 })
    await w.advance(18_000)
    // One miss since the real turn, not two: it goes on.
    expect(w.events.at(-1)).toMatchObject({ state: "renewed", renewals: 1 })
    expect(w.timers()).toBe(1)
  })

  it("on any failure of the provider: a stop for that session, and nothing thrown", async () => {
    w.state.answers = [new Error("429 rate limited")]
    await turn(realRequest(anthropic))
    await w.advance(18_000)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped", reason: "the keep-alive request failed" })
    expect(w.timers()).toBe(0)
    // The next real turn arms it again.
    await turn(realRequest(anthropic))
    expect(w.timers()).toBe(1)
  })

  it("with no client attached it does not spend a token", async () => {
    await turn(realRequest(anthropic))
    w.state.attached = 0
    await w.advance(18_000)
    expect(w.sent).toHaveLength(0)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped", reason: "no client attached" })
  })
})

describe("never during a turn, never in a run, never unless it is switched on", () => {
  it("a session that is not idle is left alone, and given up on at the expiry", async () => {
    await turn(realRequest(anthropic))
    w.state.quiet = false
    await w.advance(25_000)
    expect(w.sent).toHaveLength(0)
    expect(w.events.at(-1)).toMatchObject({ state: "stopped", reason: "the session was busy until the entry expired" })
  })

  it("a session that becomes idle before the expiry is kept after all", async () => {
    await turn(realRequest(anthropic))
    w.state.quiet = false
    await w.advance(18_000)
    expect(w.sent).toHaveLength(0)
    w.state.quiet = true
    await w.advance(1_000)
    expect(w.sent).toHaveLength(1)
  })

  it("a real request takes over: the timer goes, and a keep-alive in flight is aborted and its answer ignored", async () => {
    w.state.answers = ["hang"]
    await turn(realRequest(anthropic))
    await w.advance(18_000)
    expect(w.sent).toHaveLength(1)
    // The turn starts while the keep-alive is out.
    CacheKeeper.observe({ sessionID: SESSION, request: realRequest(anthropic), fetch: undefined })
    expect(w.sent[0]!.signal.aborted).toBe(true)
    const rendered = w.events.length
    for (const resolve of w.state.pending) resolve(READ)
    await w.flush()
    expect(w.events).toHaveLength(rendered)
    // Nothing is armed until that turn's own answer: the observed request has not answered.
    expect(w.timers()).toBe(0)
    await w.advance(60_000)
    expect(w.sent).toHaveLength(1)
  })

  it("an answer that is not the observed request's (a title, a compaction) arms nothing", async () => {
    CacheKeeper.observe({ sessionID: SESSION, request: realRequest(anthropic), fetch: undefined })
    await CacheKeeper.used(SESSION, BIG)
    expect(w.timers()).toBe(1)
    await w.advance(18_000)
    const sentBefore = w.sent.length
    await CacheKeeper.used(SESSION, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 })
    expect(w.sent).toHaveLength(sentBefore)
    expect(CacheKeeper.status(SESSION)?.stopped).toBe(false)
  })

  it("`nikcli run` switches it off for its process: nothing is observed, nothing is armed", async () => {
    CacheKeeper.disableForProcess()
    await turn(realRequest(anthropic))
    expect(w.timers()).toBe(0)
    expect(CacheKeeper.status(SESSION)).toBeUndefined()
    await w.advance(60_000)
    expect(w.sent).toHaveLength(0)
  })

  it("is off unless the switch is on", async () => {
    w.state.settings = { ...w.state.settings, enabled: false }
    await turn(realRequest(anthropic))
    expect(w.timers()).toBe(0)
    expect(CacheKeeper.status(SESSION)).toBeUndefined()
  })

  it("only for the routes it knows: another provider is left alone", async () => {
    const other = { ...realRequest(anthropic), model: { ...anthropic, route: "gemini" } } as unknown as LLMRequest
    CacheKeeper.observe({ sessionID: SESSION, request: other, fetch: undefined })
    expect(CacheKeeper.status(SESSION)).toBeUndefined()
  })

  it("keeps each session on its own", async () => {
    await turn(realRequest(anthropic), BIG, "ses_a")
    await w.advance(10_000)
    await turn(realRequest(anthropic), BIG, "ses_b")
    await w.advance(8_000)
    expect(w.sent).toHaveLength(1)
    await w.advance(10_000)
    expect(w.sent).toHaveLength(2)
  })
})

describe("the wiring", () => {
  it("`nikcli run` switches the keeper off before it opens its session", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const source = readFileSync(join(import.meta.dir, "..", "..", "src", "cli", "handlers", "run.ts"), "utf8")
    const off = source.indexOf("CacheKeeper.disableForProcess()")
    expect(off).toBeGreaterThan(0)
    expect(off).toBeLessThan(source.indexOf("await bootstrap(process.cwd()"))
  })

  it("counts the event streams attached, and not the ones that went away", async () => {
    const { EventFeed } = await import("@/server/httpapi/event-feed")
    const controller = (): ReadableStreamDefaultController<Uint8Array> =>
      ({ desiredSize: 10, enqueue() {}, close() {} }) as unknown as ReadableStreamDefaultController<Uint8Array>
    const feed = new EventFeed.Feed((event) => event)
    const before = EventFeed.attached()
    const a = feed.attach(controller())
    const b = feed.attach(controller())
    expect(EventFeed.attached()).toBe(before + 2)
    a.close()
    a.close()
    expect(EventFeed.attached()).toBe(before + 1)
    b.abandon()
    expect(EventFeed.attached()).toBe(before)
  })
})

/** On Codex the keeper is on without a variable; everywhere else it needs the variables, as before. Real `settings()`, fake provider. */
describe("on by default on Codex only", () => {
  const VARS = [
    "NIKCLI_CACHE_KEEPALIVE",
    "NIKCLI_CACHE_KEEPALIVE_COMPACT",
    "NIKCLI_COMPACTION_SHARED_PREFIX",
    "NIKCLI_CACHE_KEEPALIVE_LIFETIME_S",
    "NIKCLI_CACHE_KEEPALIVE_MAX_RENEWALS",
  ]
  const clear = () => {
    for (const name of VARS) delete process.env[name]
  }
  beforeEach(() => {
    clear()
    CacheKeeper.useDeps({ ...w.deps, settings: (codex) => CacheKeeper.settings(codex) })
  })
  afterEach(clear)

  const codexTurn = async (request: LLMRequest, session = SESSION) => {
    CacheKeeper.observe({ sessionID: session, request, fetch: undefined, codex: true })
    await CacheKeeper.used(session, BIG)
  }

  it("Codex, no variables: armed with a lifetime of 2400 s, fires at the margin, compacts when the budget is spent", async () => {
    CacheKeeper.markCodex(SESSION)
    expect(CacheKeeper.sharedPrefix(SESSION)).toBe(true)
    await codexTurn(realRequest(openai))
    expect(w.events.at(-1)).toMatchObject({ state: "armed", renewals: 0, expiresAt: w.now() + 2_400_000 })
    await w.advance(2_100_000)
    expect(w.sent).toHaveLength(0)
    await w.advance(100_000)
    expect(w.sent).toHaveLength(1)
    // The Codex budget (2 renewals), then the idle compaction.
    await w.advance(24 * 60 * 60_000)
    expect(w.sent).toHaveLength(CacheKeeper.CODEX_MAX_RENEWALS)
    expect(w.sent).toHaveLength(2)
    expect(w.state.compacted).toEqual([SESSION])
    expect(w.events.at(-1)).toMatchObject({ state: "compacted", reason: "budget spent" })
  })

  it("Codex with MAX_RENEWALS=5: five keep-alives, then the compaction; other routes keep the break-even", async () => {
    process.env["NIKCLI_CACHE_KEEPALIVE_MAX_RENEWALS"] = "5"
    await codexTurn(realRequest(openai))
    await w.advance(24 * 60 * 60_000)
    expect(w.sent).toHaveLength(5)
    expect(w.state.compacted).toEqual([SESSION])
    delete process.env["NIKCLI_CACHE_KEEPALIVE_MAX_RENEWALS"]
    expect(CacheKeeper.settings(true)).toMatchObject({ maxRenewals: 2, horizonS: undefined })
    expect(CacheKeeper.settings(false).maxRenewals).toBeUndefined()
  })

  it("Codex with NIKCLI_CACHE_KEEPALIVE=0: no keep-alive, nothing armed", async () => {
    process.env["NIKCLI_CACHE_KEEPALIVE"] = "0"
    await codexTurn(realRequest(openai))
    await w.advance(24 * 60 * 60_000)
    expect(w.sent).toHaveLength(0)
    expect(w.events).toHaveLength(0)
    expect(w.timers()).toBe(0)
  })

  it("Codex with the compaction or the shared prefix switched off: keep-alives, but no compaction", async () => {
    process.env["NIKCLI_CACHE_KEEPALIVE_COMPACT"] = "0"
    expect(CacheKeeper.settings(true)).toMatchObject({ enabled: true, compact: false })
    delete process.env["NIKCLI_CACHE_KEEPALIVE_COMPACT"]
    process.env["NIKCLI_COMPACTION_SHARED_PREFIX"] = "0"
    expect(CacheKeeper.settings(true)).toMatchObject({ enabled: true, compact: false })
    CacheKeeper.markCodex("ses_codex_2")
    expect(CacheKeeper.sharedPrefix("ses_codex_2")).toBe(false)
  })

  it("variables set win over the Codex default", async () => {
    process.env["NIKCLI_CACHE_KEEPALIVE_LIFETIME_S"] = "300"
    process.env["NIKCLI_CACHE_KEEPALIVE_MAX_RENEWALS"] = "0"
    expect(CacheKeeper.settings(true)).toMatchObject({ lifetimeS: 300, maxRenewals: 0 })
    await codexTurn(realRequest(openai))
    expect(w.events.at(-1)).toMatchObject({ state: "armed", expiresAt: w.now() + 300_000 })
    await w.advance(24 * 60 * 60_000)
    expect(w.sent).toHaveLength(0)
    expect(w.state.compacted).toEqual([SESSION])
  })

  it("Anthropic and OpenAI with an API key (not Codex), no variables: no keep-alive, as before", async () => {
    expect(CacheKeeper.settings()).toMatchObject({ enabled: false, lifetimeS: undefined, compact: false })
    expect(CacheKeeper.active(undefined, false)).toBe(false)
    expect(CacheKeeper.sharedPrefix("ses_plain")).toBe(false)
    for (const model of [anthropic, openai]) {
      CacheKeeper.observe({ sessionID: "ses_plain", request: realRequest(model), fetch: undefined })
      await CacheKeeper.used("ses_plain", BIG)
    }
    await w.advance(24 * 60 * 60_000)
    expect(w.sent).toHaveLength(0)
    expect(w.events).toHaveLength(0)
  })

  it("the variables still turn it on for the others", async () => {
    process.env["NIKCLI_CACHE_KEEPALIVE"] = "1"
    expect(CacheKeeper.settings()).toMatchObject({ enabled: true, lifetimeS: undefined, compact: false })
    process.env["NIKCLI_CACHE_KEEPALIVE_COMPACT"] = "1"
    process.env["NIKCLI_COMPACTION_SHARED_PREFIX"] = "1"
    expect(CacheKeeper.settings()).toMatchObject({ compact: true })
  })
})
