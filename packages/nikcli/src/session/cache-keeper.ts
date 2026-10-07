// The cache keeper: keeps a session's prompt-cache entry alive while the session is idle.
//
// A provider's prompt cache lives minutes (Anthropic: 5 minutes, or 1 hour with the long entry) after its last use. A session left
// open outlives that, and the next turn then writes the whole context again at full price (Anthropic: 2x base input for the 1-hour
// entry, 1.25x for the 5-minute one) where a read costs about 0.1x. The keeper sends one hidden request shortly before the entry
// would expire, with exactly the prefix of the last real request, so the entry is read (and its lifetime renewed) at the price of a
// read.
//
// What it is, and is not:
//
// - Off unless `NIKCLI_CACHE_KEEPALIVE` is set, and then only for a session of a process with a client attached (the TUI, or a server
//   with an event stream open) and never in `nikcli run` (`disableForProcess`, called by the run handler).
// - Never during a turn: the session must be `idle` with nothing queued when it fires, and any real request cancels the timer and
//   aborts a keep-alive in flight, so the keeper can only ever make a turn start from a warmer cache, never later.
// - Never in the session's history: the hidden request is the last real `LLMRequest` itself with only its output cap changed, sent
//   through `Runtime.generateRequest`, which runs no tool and writes nothing. The cache key is the prefix (tools, system, messages),
//   which is byte-identical because it is the same request.
// - Never an error of a turn: a failure (rate limit, auth, a response that shows the entry was gone) is a log line and stops the
//   keeper for that session. A real turn arms it again.
//
// The clock, the sender and the session gates are parameters (`Deps`) so the whole behaviour is tested with a fake provider and a
// lifetime of seconds, and the production wiring is a handful of lines at the bottom.
import { GenerationOptions, LLMRequest, Runtime } from "@nikcli-ai/llm"
import type { LLMRequest as LLMRequestType } from "@nikcli-ai/llm"
import { Effect, Schema, type Layer } from "effect"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { EventFeed } from "@/server/httpapi/event-feed"
import { runPromiseWithLayer } from "@/effect/runtime"
import { locallyInstance, type InstanceContext } from "@/effect/instance-ref"
import { ambient } from "@/effect/instance-state"
import { Log } from "@nikcli-ai/util/log"
import { Flag } from "@nikcli-ai/util/flag"

export namespace CacheKeeper {
  const log = Log.create({ service: "cache.keeper" })

  /** What a keeper says about a session's entry, on the bus (the TUI shows it) and in the log. */
  export type State = "armed" | "renewed" | "compacted" | "stopped"

  export interface Usage {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }

  export const Event = {
    Cache: BusEvent.schema(
      "session.cache",
      Schema.Struct({
        sessionID: Schema.String,
        state: Schema.Literals(["armed", "renewed", "compacted", "stopped"]),
        /** When the entry expires if nothing touches it, ms since the epoch. */
        expiresAt: Schema.optional(Schema.Number),
        renewals: Schema.Number,
        reason: Schema.optional(Schema.String),
        usage: Schema.optional(
          Schema.Struct({
            input: Schema.Number,
            output: Schema.Number,
            cacheRead: Schema.Number,
            cacheWrite: Schema.Number,
          }),
        ),
      }),
      { delivery: "snapshot" },
    ),
  }

  // ---------------------------------------------------------------- settings

  export interface Settings {
    readonly enabled: boolean
    /** Lifetime of the entry in seconds, when it cannot be read off the request (OpenAI/Codex) or is overridden. */
    readonly lifetimeS: number | undefined
    /** How long before the expiry to fire, as a percent of the lifetime. */
    readonly marginPct: number
    /** Below this many tokens of prefix a rewrite is cheap and nothing is kept alive. */
    readonly minTokens: number
    /** Renewals after which the keeper stops; `0` is no keep-alive at all, `undefined` is the break-even of the provider. */
    readonly maxRenewals: number | undefined
    /** Seconds after the last real request at which the keeper stops, whatever the renewals. */
    readonly horizonS: number | undefined
    /** At the end of the budget compact the session (with the shared prefix, still cached) instead of letting the entry die. */
    readonly compact: boolean
  }

  export function settings(): Settings {
    return {
      enabled: Flag.cacheKeepalive(),
      lifetimeS: Flag.cacheKeepaliveNumber("NIKCLI_CACHE_KEEPALIVE_LIFETIME_S"),
      marginPct: Flag.cacheKeepaliveNumber("NIKCLI_CACHE_KEEPALIVE_MARGIN_PCT") ?? 10,
      minTokens: Flag.cacheKeepaliveNumber("NIKCLI_CACHE_KEEPALIVE_MIN_TOKENS") ?? 20_000,
      maxRenewals: Flag.cacheKeepaliveNumber("NIKCLI_CACHE_KEEPALIVE_MAX_RENEWALS", { allowZero: true }),
      horizonS: Flag.cacheKeepaliveNumber("NIKCLI_CACHE_KEEPALIVE_HORIZON_S"),
      // Both switches: the compaction that is cheap is the one that shares the prefix, and without it this would rewrite the context.
      compact: Flag.cacheKeepaliveCompact() && Flag.compactionSharedPrefix(),
    }
  }

  // ---------------------------------------------------------------- the request

  /** The output cap of the hidden request: Anthropic takes 1, the Responses API wants at least 16. */
  export function outputCap(route: string): number {
    return route === "openai-responses" ? 16 : 1
  }

  /** The routes the keeper knows how to keep: the ones whose cache is the request's prefix and whose cap is known. */
  export const ROUTES = ["anthropic-messages", "openai-responses"] as const

  /**
   * The last real request with its output cap changed and nothing else: the same tools, system, messages, `toolChoice`, provider
   * options and headers, so the prefix the provider matches is the same bytes.
   */
  export function hiddenRequest(request: LLMRequestType): LLMRequestType {
    const generation = new GenerationOptions({ ...(request.generation ?? {}), maxTokens: outputCap(request.model.route) })
    return LLMRequest.update(request, { generation })
  }

  /** Keys that carry the output cap on the wire: the only thing a real request and its keep-alive may differ in. */
  const GENERATION_KEYS = new Set(["max_tokens", "max_output_tokens", "max_completion_tokens"])

  /** A wire body without its output cap: what the provider matches its cache against. Used by the tests to dump and compare. */
  export function prefixOf(body: unknown): unknown {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body
    return Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([key]) => !GENERATION_KEYS.has(key)))
  }

  /** The lifetime of the entry a body asks for: the hour when any block carries `ttl: "1h"`, the 5 minutes otherwise. */
  export function anthropicLifetimeS(body: unknown): number {
    const seen = (value: unknown, depth = 0): boolean => {
      if (depth > 8 || value === null || typeof value !== "object") return false
      if (Array.isArray(value)) return value.some((item) => seen(item, depth + 1))
      return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
        key === "cache_control" && item && typeof item === "object" ? (item as { ttl?: unknown }).ttl === "1h" : seen(item, depth + 1),
      )
    }
    return seen(body) ? 3_600 : 300
  }

  /**
   * Renewals after which keeping the entry alive costs more than letting it die: the price of writing it again over the price of a
   * read. Anthropic's 1-hour entry writes at 2x and reads at 0.1x (20); the 5-minute entry writes at 1.25x (12); OpenAI has no write
   * price, so what it saves is the whole discount of a read (10).
   */
  export function breakEven(route: string, lifetimeS: number): number {
    if (route === "anthropic-messages") return Math.floor((lifetimeS >= 3_600 ? 2 : 1.25) / 0.1)
    return Math.floor(1 / 0.1)
  }

  // ---------------------------------------------------------------- state per session

  export interface Observation {
    readonly sessionID: string
    readonly request: LLMRequestType
    /** The provider's own `fetch` (OAuth renewal and account tokens live in it). */
    readonly fetch: typeof globalThis.fetch | undefined
    readonly startedAt?: number
    /** The instance the session lives in, which a timer cannot find again by itself. */
    readonly ctx?: unknown
  }

  export interface Deps {
    now(): number
    setTimer(run: () => void, ms: number): unknown
    clearTimer(handle: unknown): void
    /** The wire body of a request, for the lifetime a request asks for. */
    prepare(request: LLMRequestType): Promise<{ readonly body: unknown }>
    /** Send the hidden request. Rejects on any failure; never resolves a response with an error in it. */
    send(request: LLMRequestType, fetch: typeof globalThis.fetch | undefined, signal: AbortSignal): Promise<Usage | undefined>
    /** Compact the session now, through the loop (a manual compaction, so no model turn follows). Rejects on any failure. */
    compact(sessionID: string, ctx: unknown): Promise<void>
    /** Whether the session is idle with no input waiting. */
    quiet(sessionID: string, ctx: unknown): Promise<boolean>
    /** Event streams attached to this process: a keeper without a client does not spend a token. */
    attached(): number
    publish(
      event: {
        sessionID: string
        state: State
        expiresAt?: number
        renewals: number
        reason?: string
        usage?: Usage
      },
      ctx: unknown,
    ): void
    settings(): Settings
  }

  interface Entry {
    readonly sessionID: string
    readonly ctx: unknown
    request: LLMRequestType
    fetch: typeof globalThis.fetch | undefined
    /** Bumped by every real request: a keep-alive that finds a newer number than it started with was overtaken. */
    generation: number
    lastTouch: number
    firstTouch: number
    lifetimeMs?: number
    prefixTokens: number
    renewals: number
    /** Keep-alives in a row that read nothing from the cache; a hit, or a real request (a new entry), starts it again. */
    misses: number
    timer?: unknown
    flight?: AbortController
    stopped: boolean
    /** A real request was observed and has not answered yet: only its answer may arm the timer. */
    awaiting: boolean
  }

  const MAX_SESSIONS = 64
  /** Keep-alives in a row that may miss before the keeper gives up on the session. */
  const MAX_MISSES_IN_A_ROW = 2
  const entries = new Map<string, Entry>()
  let disabled = false
  let deps: Deps | undefined

  /** `nikcli run` (and anything else that is one-shot) calls this: a process that exits has nothing to keep alive. */
  export function disableForProcess() {
    disabled = true
    for (const entry of [...entries.values()]) forget(entry.sessionID)
  }

  export function active(d = dependencies()): boolean {
    return !disabled && d.settings().enabled
  }

  export function dependencies(): Deps {
    return (deps ??= productionDeps())
  }

  /** Tests give the keeper a fake clock, sender and gates, and take them away again with `undefined`. */
  export function useDeps(next: Deps | undefined) {
    for (const entry of [...entries.values()]) forget(entry.sessionID)
    deps = next
    disabled = false
  }

  export function status(sessionID: string): { stopped: boolean; renewals: number; expiresAt?: number } | undefined {
    const entry = entries.get(sessionID)
    if (!entry) return undefined
    return {
      stopped: entry.stopped,
      renewals: entry.renewals,
      expiresAt: entry.lifetimeMs === undefined ? undefined : entry.lastTouch + entry.lifetimeMs,
    }
  }

  function clear(entry: Entry) {
    if (entry.timer !== undefined) dependencies().clearTimer(entry.timer)
    entry.timer = undefined
    entry.flight?.abort()
    entry.flight = undefined
  }

  function forget(sessionID: string) {
    const entry = entries.get(sessionID)
    if (!entry) return
    clear(entry)
    // An asynchronous step of the keeper that is holding this entry (a gate, a request) must find it ended.
    entry.stopped = true
    entry.flight?.abort()
    entries.delete(sessionID)
  }

  function stop(entry: Entry, reason: string, extra?: Record<string, unknown>) {
    if (entry.stopped) return
    clear(entry)
    entry.stopped = true
    log.info("cache keeper stopped", { sessionID: entry.sessionID, reason, renewals: entry.renewals, ...extra })
    dependencies().publish({ sessionID: entry.sessionID, state: "stopped", renewals: entry.renewals, reason }, entry.ctx)
  }

  /**
   * The budget or the horizon is reached while the entry is still warm: stop, or, with the compaction switch, compact first so the
   * resume pays for the summary and not for the whole context. A failure, or a session that is not idle any more, is a stop.
   */
  function finish(entry: Entry, reason: string, extra?: Record<string, unknown>) {
    const d = dependencies()
    if (!d.settings().compact) return stop(entry, reason, extra)
    clear(entry)
    const generation = entry.generation
    // Not now: the entry is warm until it expires, and a compaction that reads it is as cheap at the margin before the expiry as at
    // the end of the turn, while a session that is resumed in between has lost nothing. With a budget of 0 this is the whole point:
    // no keep-alive, and the one request left is the compaction.
    const lifetime = entry.lifetimeMs ?? 0
    const expiresAt = entry.lastTouch + lifetime
    const delay = Math.max(0, expiresAt - marginMs(entry, d) - d.now())
    d.publish({ sessionID: entry.sessionID, state: entry.renewals === 0 ? "armed" : "renewed", expiresAt, renewals: entry.renewals }, entry.ctx)
    entry.timer = d.setTimer(() => {
      entry.timer = undefined
      if (entry.stopped || entry.generation !== generation) return
      void compactNow()
    }, delay)
    const compactNow = async () => {
      try {
        if (!(await d.quiet(entry.sessionID, entry.ctx)) || entry.generation !== generation || entry.stopped) {
          return stop(entry, `${reason}; not idle for the compaction`, extra)
        }
        log.info("cache keeper compacting", { sessionID: entry.sessionID, reason, renewals: entry.renewals })
        await d.compact(entry.sessionID, entry.ctx)
        if (entry.generation !== generation || entry.stopped) return
        // The prefix is the summary's now: nothing left to keep until the next real request observes the new one.
        entry.stopped = true
        d.publish({ sessionID: entry.sessionID, state: "compacted", renewals: entry.renewals, reason }, entry.ctx)
      } catch (error) {
        if (entry.generation !== generation || entry.stopped) return
        stop(entry, "the idle compaction failed", { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  // ---------------------------------------------------------------- the three hooks

  /**
   * A real request of the session is about to go out (`LLM.streamNative`). It takes over from any keep-alive: the timer is cleared, a
   * request in flight is aborted, and the budget starts again, since the entry is being read or written by the turn itself.
   */
  export function observe(input: Observation) {
    const d = dependencies()
    if (!active(d)) return
    if (!(ROUTES as readonly string[]).includes(input.request.model.route)) return
    const previous = entries.get(input.sessionID)
    if (previous) clear(previous)
    if (!previous && entries.size >= MAX_SESSIONS) {
      const oldest = entries.keys().next().value
      if (oldest !== undefined) forget(oldest)
    }
    const now = input.startedAt ?? d.now()
    const entry: Entry = {
      sessionID: input.sessionID,
      ctx: input.ctx,
      request: input.request,
      fetch: input.fetch,
      generation: (previous?.generation ?? 0) + 1,
      lastTouch: now,
      firstTouch: now,
      lifetimeMs: undefined,
      prefixTokens: 0,
      renewals: 0,
      misses: 0,
      stopped: false,
      awaiting: true,
    }
    entries.set(input.sessionID, entry)
    const budget = thinkingBudget(input.request)
    if (budget !== undefined) {
      stop(entry, "thinking with a budget: Anthropic rejects an output cap of 1 below the budget", { budgetTokens: budget })
    }
  }

  /**
   * The real request answered (`SessionProcessor`, `finish-step`): its usage says whether an entry exists and how big it is, which is
   * what decides whether there is anything to keep. This is where the timer is armed.
   */
  export async function used(sessionID: string, usage: Usage) {
    const entry = entries.get(sessionID)
    // An answer that is not the one of the observed request (a title, a compaction, the next step's) arms nothing.
    if (!entry || entry.stopped || !entry.awaiting) return
    entry.awaiting = false
    const d = dependencies()
    if (!active(d)) return forget(sessionID)
    const generation = entry.generation
    entry.prefixTokens = usage.input + usage.cacheRead + usage.cacheWrite
    if (usage.cacheRead + usage.cacheWrite === 0) return stop(entry, "no cache entry: the provider reported no cached tokens")
    try {
      entry.lifetimeMs = await lifetimeMs(entry, d)
    } catch (error) {
      return stop(entry, "cannot tell the lifetime of the entry", { error: String(error) })
    }
    if (entry.generation !== generation || entry.stopped) return
    if (entry.lifetimeMs === undefined) return stop(entry, "no lifetime known for this provider")
    arm(entry, d)
  }

  /** The session is gone (deleted, or its instance disposed). */
  export function release(sessionID: string) {
    forget(sessionID)
  }

  /** The instance was disposed: its sessions' timers and requests end with it. */
  export function releaseInstance(ctx: unknown) {
    for (const entry of [...entries.values()]) if (entry.ctx === ctx) forget(entry.sessionID)
  }

  /**
   * Anthropic wants `max_tokens` above the `budget_tokens` of a thinking budget, and the hidden request caps the output at 1: every
   * keep-alive of such a session would be a 400. Lowering the thinking instead would change the parameters the cache is keyed on, and
   * raising `max_tokens` would let the model think at full price. So the keeper does not start for it.
   */
  export function thinkingBudget(request: LLMRequestType): number | undefined {
    if (request.model.route !== "anthropic-messages") return undefined
    const thinking = (request.providerOptions as { anthropic?: { thinking?: Record<string, unknown> } } | undefined)?.anthropic?.thinking
    if (!thinking || thinking["type"] !== "enabled") return undefined
    const budget = thinking["budgetTokens"] ?? thinking["budget_tokens"]
    return typeof budget === "number" ? budget : 0
  }

  // ---------------------------------------------------------------- the timer

  async function lifetimeMs(entry: Entry, d: Deps): Promise<number | undefined> {
    const override = d.settings().lifetimeS
    if (override !== undefined) return override * 1_000
    // Anthropic says on the wire how long the entry lives. OpenAI's cache is implicit, with no lifetime to read: it is configured
    // (`NIKCLI_CACHE_KEEPALIVE_LIFETIME_S`) until a measurement exists, and with none the keeper is off for it.
    if (entry.request.model.route === "anthropic-messages") {
      const prepared = await d.prepare(entry.request)
      return anthropicLifetimeS(prepared.body) * 1_000
    }
    return undefined
  }

  function marginMs(entry: Entry, d: Deps) {
    return Math.max(1_000, Math.round((entry.lifetimeMs ?? 0) * (d.settings().marginPct / 100)))
  }

  function arm(entry: Entry, d: Deps) {
    if (entry.stopped || entry.lifetimeMs === undefined) return
    const s = d.settings()
    if (entry.prefixTokens < s.minTokens) {
      return stop(entry, "prefix below the threshold", { tokens: entry.prefixTokens, minTokens: s.minTokens })
    }
    const lifetimeS = entry.lifetimeMs / 1_000
    const budget = s.maxRenewals ?? breakEven(entry.request.model.route, lifetimeS)
    if (entry.renewals >= budget) return finish(entry, "budget spent", { budget })
    const now = d.now()
    if (s.horizonS !== undefined && now - entry.firstTouch >= s.horizonS * 1_000) return finish(entry, "horizon reached")
    const expiresAt = entry.lastTouch + entry.lifetimeMs
    const delay = Math.max(0, expiresAt - marginMs(entry, d) - now)
    clear(entry)
    const generation = entry.generation
    entry.timer = d.setTimer(() => void fire(entry, generation), delay)
    d.publish({ sessionID: entry.sessionID, state: entry.renewals === 0 ? "armed" : "renewed", expiresAt, renewals: entry.renewals }, entry.ctx)
  }

  async function fire(entry: Entry, generation: number) {
    const d = dependencies()
    entry.timer = undefined
    if (entry.stopped || entry.generation !== generation) return
    try {
      if (!active(d)) return forget(entry.sessionID)
      if (d.attached() === 0) return stop(entry, "no client attached")
      const lifetime = entry.lifetimeMs ?? 0
      const expiresAt = entry.lastTouch + lifetime
      // Not idle (a turn is running or input is waiting): the turn will touch the entry itself. Look again before the entry would
      // expire, and give up at the expiry.
      if (!(await d.quiet(entry.sessionID, entry.ctx))) {
        if (entry.generation !== generation || entry.stopped) return
        const now = d.now()
        if (now >= expiresAt) return stop(entry, "the session was busy until the entry expired")
        entry.timer = d.setTimer(() => void fire(entry, generation), Math.min(Math.max(1_000, marginMs(entry, d) / 2), expiresAt - now))
        return
      }
      if (entry.generation !== generation || entry.stopped) return
      const flight = new AbortController()
      entry.flight = flight
      const sentAt = d.now()
      let usage: Usage | undefined
      try {
        usage = await d.send(hiddenRequest(entry.request), entry.fetch, flight.signal)
      } finally {
        if (entry.flight === flight) entry.flight = undefined
      }
      // A real request took over while this one was in flight: its own answer decides what the entry is now.
      if (entry.generation !== generation || entry.stopped || flight.signal.aborted) return
      if (!usage) return stop(entry, "the provider returned no usage")
      log.info("cache keepalive", {
        sessionID: entry.sessionID,
        renewal: entry.renewals + 1,
        cached: usage.cacheRead,
        uncached: usage.input,
        written: usage.cacheWrite,
        output: usage.output,
        elapsedMs: d.now() - sentAt,
      })
      /*
       * A miss (nothing read from the cache) still wrote the entry again, at full price, so it counts as a renewal: it uses the budget
       * like a hit, and the next keep-alive is timed from it. OpenAI reports no cache writes (`cacheWrite` stays 0): there a miss is an
       * implicit write too, and the rule is the same for every provider. Two in a row stop the keeper: a key that never gets the cache
       * (routing, load) would otherwise rewrite the entry at every round. A hit starts the count again.
       */
      const miss = usage.cacheRead === 0
      entry.misses = miss ? entry.misses + 1 : 0
      if (miss) {
        log.info("cache keepalive miss", {
          sessionID: entry.sessionID,
          miss: true,
          uncached: usage.input,
          written: usage.cacheWrite,
          misses: entry.misses,
        })
      }
      entry.renewals += 1
      entry.lastTouch = sentAt
      if (entry.misses >= MAX_MISSES_IN_A_ROW) {
        return stop(entry, "two misses in a row", { uncached: usage.input, written: usage.cacheWrite })
      }
      d.publish(
        {
          sessionID: entry.sessionID,
          state: "renewed",
          expiresAt: entry.lastTouch + lifetime,
          renewals: entry.renewals,
          usage,
        },
        entry.ctx,
      )
      arm(entry, d)
    } catch (error) {
      if (entry.generation !== generation || entry.stopped) return
      // A failure of the keeper is a line in the log and the end of the keeper for this session: never an error of a turn.
      stop(entry, "the keep-alive request failed", { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // ---------------------------------------------------------------- production wiring

  function productionDeps(): Deps {
    return {
      now: () => Date.now(),
      setTimer: (run, ms) => {
        const handle = setTimeout(run, ms)
        // A keeper must never be what keeps a process alive.
        ;(handle as { unref?: () => void }).unref?.()
        return handle
      },
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      prepare: (request) => Runtime.prepareRequest(request),
      send: async (request, fetch, signal) => {
        const response = await Runtime.generateRequest(request, { fetch, signal })
        const usage = response.usage
        if (!usage) return undefined
        return {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cacheRead: usage.cacheReadInputTokens ?? 0,
          cacheWrite: usage.cacheWriteInputTokens ?? 0,
        }
      },
      compact: async (sessionID, ctx) => {
        // Loaded when asked: the session modules import this one.
        const [{ Session }, { SessionCompaction }, { SessionPrompt }] = await Promise.all([
          import("."),
          import("./compaction"),
          import("./prompt"),
        ])
        const at = <A, E, R>(layer: Layer.Layer<R>, effect: Effect.Effect<A, E, R>) =>
          runPromiseWithLayer(layer, locallyInstance(ctx as InstanceContext, effect))
        const last = await at(
          Session.defaultLayer,
          Effect.gen(function* () {
            const messages = yield* (yield* Session.Service).messages({ sessionID })
            return messages.findLast((m) => m.info.role === "user")?.info
          }),
        )
        if (!last || last.role !== "user") throw new Error("no user message to compact from")
        await at(
          SessionCompaction.defaultLayer,
          Effect.gen(function* () {
            yield* (yield* SessionCompaction.Service).create({ sessionID, agent: last.agent, model: last.model, auto: false })
          }),
        )
        await at(
          SessionPrompt.defaultLayer,
          Effect.gen(function* () {
            yield* (yield* SessionPrompt.Service).loop(sessionID)
          }),
        )
      },
      quiet: async (sessionID, ctx) => {
        // Loaded when asked: the session modules import this one.
        const { SessionStatus } = await import("./status")
        const { SessionPending } = await import("./pending")
        const status = await runPromiseWithLayer(
          SessionStatus.defaultLayer,
          locallyInstance(
            ctx as InstanceContext,
            Effect.gen(function* () {
              return yield* (yield* SessionStatus.Service).get(sessionID)
            }),
          ),
        )
        if (status.type !== "idle") return false
        // A session that was deleted reads as idle: nothing to keep alive for it.
        const { Session } = await import(".")
        const exists = await runPromiseWithLayer(
          Session.defaultLayer,
          locallyInstance(
            ctx as InstanceContext,
            Effect.gen(function* () {
              return yield* (yield* Session.Service).get(sessionID)
            }),
          ),
        ).then(
          () => true,
          () => false,
        )
        if (!exists) {
          release(sessionID)
          return false
        }
        return (
          Effect.runSync(SessionPending.list(sessionID, "steer")).length === 0 &&
          Effect.runSync(SessionPending.list(sessionID, "queue")).length === 0
        )
      },
      attached: () => EventFeed.attached(),
      publish: (event, ctx) => {
        void runPromiseWithLayer(
          Bus.defaultLayer,
          locallyInstance(
            ctx as InstanceContext,
            Effect.flatMap(Effect.service(Bus.Service), (bus) => bus.publish(Event.Cache, event)),
          ),
        ).catch((error) => log.debug("cache event not published", { error: String(error) }))
      },
      settings,
    }
  }

  /** The instance of the caller, for `Observation.ctx`; undefined where there is none (a test, a script). */
  export function instanceOf(): InstanceContext | undefined {
    try {
      return ambient()
    } catch {
      return undefined
    }
  }
}
