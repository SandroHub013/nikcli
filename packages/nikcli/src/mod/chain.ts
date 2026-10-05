import { AsyncLocalStorage } from "node:async_hooks"
import { Cause, Effect, Exit } from "effect"
import { Log } from "@nikcli-ai/util/log"

/**
 * The mod middleware chain, as an Effect.
 *
 * A mod registers hooks with `on(event, [matcher], hook)`. Every hook on one
 * event forms a single chain: `next(e)` runs the hooks after this one and then
 * the engine's own behaviour (`final`), and resolves to the event's result. A
 * hook that never calls `next` answers the event itself. The first mod in the
 * chain is the outermost: it sees the event first and the result last.
 *
 * `emit` is an `Effect<T, E, R>` where `E` and `R` are the engine behaviour's
 * own: a hook failing never reaches the typed channel, and a failure of the
 * engine's behaviour always does, whichever hook was in the middle of waiting
 * on it. Hooks are Promise functions — they are written by third parties — so
 * `next` crosses back into Effect with `runPromiseWith` and carries the whole
 * `Cause` across, not a flattened message.
 *
 * Imports nothing from the rest of nikcli, so the semantics are testable
 * without an instance.
 */
export namespace ModChain {
  const log = Log.create({ service: "mod" })

  /** Where a mod sits in the order. `core` is the engine itself. */
  export type Tier = "prepend" | "user" | "append" | "builtin"
  export type Origin = { plugin: string; tier: Tier | "core" }
  export type Matcher = Record<string, unknown>
  export type ErrorInfo = { kind: "throw" | "timeout"; message: string }

  export interface Budget {
    /** The whole limit, in milliseconds. */
    readonly ms: number
    /** What is left now. Time inside `next` or a mods API call does not count. */
    readonly remainingMs: number
  }

  export interface Next {
    (event: any): Promise<any>
    /** Aborts when the event is abandoned or the hook times out. */
    readonly signal: AbortSignal
    /** Who fired the event; the engine is `{ plugin: "engine", tier: "core" }`. */
    readonly origin: Origin
    readonly budget: Budget
    /** Skip to a later tier. Only a mod the organization listed may call it. */
    to(event: any, tier: "append" | "builtin" | "core"): Promise<any>
    /** In a `.catch` handler only. */
    readonly error?: ErrorInfo
    /** In a `.catch` handler only: whether the failed hook had called `next`. */
    readonly called?: boolean
  }

  export type Hook = ($: any, event: any, next: Next) => unknown

  export interface Registration {
    catch(handler: Hook): Registration
  }

  /** `on(event, hook)` or `on(event, matcher, hook)`. */
  export interface On {
    (event: string, hook: Hook): Registration
    (event: string, matcher: Matcher, hook: Hook): Registration
  }

  /** A loaded mod, as the chain sees it. */
  export interface Mod {
    id: string
    name: string
    tier: Tier
    /** Position in the order. Lower runs first (outermost). */
    rank: number
    /** May call `next.to`. */
    skip: boolean
    /** The `$` argument a hook receives. */
    api: () => any
  }

  type Entry = {
    mod: Mod
    event: string
    matcher?: Matcher
    hook: Hook
    onError?: Hook
  }

  export const HOOK_LIMIT_MS = 10_000
  export const CATCH_LIMIT_MS = 1_000

  const TIER_RANK: Record<Tier | "core", number> = { prepend: 1, user: 2, append: 3, builtin: 4, core: 5 }

  /** Per-hook state reachable from inside `$` calls, so they can pause the clock. */
  export type Scope = { budget: BudgetClock; sessionID?: string; signal?: AbortSignal; mod?: Mod }
  const scope = new AsyncLocalStorage<Scope>()

  /** The hook currently running in this async context, if any. */
  export function current() {
    return scope.getStore()
  }

  /**
   * Run `fn` with the hook's clock stopped. A mods API call wraps itself in
   * this: waiting on the user, the network or a process is not the hook's time.
   */
  export async function paused<T>(fn: () => Promise<T> | T): Promise<T> {
    const clock = scope.getStore()?.budget
    clock?.pause()
    try {
      return await fn()
    } finally {
      clock?.resume()
    }
  }

  /** Run `fn` with a session in scope, so `$.session.*` knows whose it is. */
  export function withSession<T>(sessionID: string | undefined, fn: () => T): T {
    const parent = scope.getStore()
    return scope.run({ budget: parent?.budget ?? new BudgetClock(HOOK_LIMIT_MS), ...parent, sessionID }, fn)
  }

  /** A stopwatch that counts only while no `next` or `$` call is in flight. */
  export class BudgetClock implements Budget {
    private spent = 0
    private since: number | undefined
    private depth = 0
    private timer: ReturnType<typeof setTimeout> | undefined
    private onTimeout: (() => void) | undefined
    constructor(readonly ms: number) {}

    get remainingMs() {
      const running = this.since === undefined ? 0 : Date.now() - this.since
      return Math.max(0, this.ms - this.spent - running)
    }

    start(onTimeout: () => void) {
      this.onTimeout = onTimeout
      this.since = Date.now()
      this.arm()
    }

    pause() {
      this.depth++
      if (this.depth !== 1 || this.since === undefined) return
      this.spent += Date.now() - this.since
      this.since = undefined
      this.disarm()
    }

    resume() {
      if (this.depth === 0) return
      this.depth--
      if (this.depth !== 0 || !this.onTimeout) return
      this.since = Date.now()
      this.arm()
    }

    stop() {
      this.onTimeout = undefined
      this.disarm()
    }

    private arm() {
      this.disarm()
      this.timer = setTimeout(() => this.onTimeout?.(), this.remainingMs)
      // A wedged hook must not keep the process alive.
      ;(this.timer as { unref?: () => void }).unref?.()
    }

    private disarm() {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  function plain(value: unknown): value is Record<string, unknown> | unknown[] {
    if (value === null || typeof value !== "object") return false
    if (Array.isArray(value)) return true
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
  }

  /**
   * A frozen deep copy of plain data. Copying first means the caller's own
   * objects are never frozen under it; anything that is not plain data (a
   * signal, a buffer) is kept by reference.
   */
  export function freeze<T>(value: T): T {
    if (!plain(value)) return value
    if (Object.isFrozen(value)) return value
    const copy: any = Array.isArray(value) ? [] : {}
    for (const key of Reflect.ownKeys(value)) copy[key] = freeze((value as any)[key])
    return Object.freeze(copy)
  }

  function matchField(expected: unknown, actual: unknown) {
    if (expected instanceof RegExp) return typeof actual === "string" && expected.test(actual)
    if (Array.isArray(expected)) return expected.includes(actual)
    return expected === actual
  }

  export function matches(matcher: Matcher | undefined, event: unknown) {
    if (!matcher) return true
    if (event === null || typeof event !== "object") return false
    for (const [key, expected] of Object.entries(matcher)) {
      if (!matchField(expected, (event as Record<string, unknown>)[key])) return false
    }
    return true
  }

  /**
   * `*` matches every event except telemetry, which names itself; `ns.*`
   * matches by prefix. Anything else is an exact name.
   */
  export function nameMatches(pattern: string, name: string) {
    if (pattern === name) return true
    if (pattern === "*") return !name.startsWith("telemetry.")
    if (pattern.endsWith(".*")) return name.startsWith(pattern.slice(0, -1))
    return false
  }

  export interface EmitOptions {
    /** Who fired the event. Defaults to the engine. */
    origin?: Origin
    /**
     * The mod that made a mods API call. Only mods that run **before** it see the call: a policy
     * mod at the front audits or refuses what the mods after it ask for.
     */
    from?: Mod
    /** Only this mod sees the event (`session.start`). */
    only?: string
    /** Aborts `next.signal` for every hook when the caller abandons the event. */
    signal?: AbortSignal
    /** Override the hook limits; tests shorten them, production leaves them. */
    limitMs?: number
    catchLimitMs?: number
    /** Reject a result of the wrong shape; the reason names what was wrong. */
    validate?: (result: unknown) => string | undefined
    /** Called when a hook is skipped, so the UI can say which mod failed. */
    report?: (info: { mod: Mod; event: string; reason: string }) => void
  }

  /** The registrations of every loaded mod, in order. Plain data, no Effect. */
  export class Registry {
    private mods = new Map<string, Mod>()
    private entries: Entry[] = []
    private order = new Map<string, number>()
    private seq = 0

    /** Add a mod atomically: a `register` that throws leaves nothing behind. */
    add(mod: Mod, register: (on: On) => void) {
      if (this.mods.has(mod.id)) throw new Error(`mod ${mod.id} is already loaded`)
      const added: Entry[] = []
      const bare = new Set<string>()
      const on: On = (...args: any[]): Registration => {
        const event = args[0]
        if (typeof event !== "string" || !event) throw new Error("on() needs an event name")
        const hook = args.length >= 3 ? args[2] : args[1]
        const matcher = args.length >= 3 ? args[1] : undefined
        if (typeof hook !== "function") throw new Error(`on("${event}") needs a hook function`)
        if (matcher !== undefined && (matcher === null || typeof matcher !== "object" || Array.isArray(matcher))) {
          throw new Error(`on("${event}") matcher must be an object`)
        }
        if (matcher === undefined) {
          if (bare.has(event)) throw new Error(`on("${event}") is registered twice without a matcher`)
          bare.add(event)
        }
        const entry: Entry = { mod, event, matcher, hook }
        added.push(entry)
        const registration: Registration = {
          catch(handler) {
            if (typeof handler !== "function") throw new Error(`.catch on "${event}" needs a function`)
            entry.onError = handler
            return registration
          },
        }
        return registration
      }
      register(on)
      this.mods.set(mod.id, mod)
      this.order.set(mod.id, this.seq++)
      this.entries.push(...added)
      return added.length
    }

    remove(id: string) {
      this.mods.delete(id)
      this.order.delete(id)
      this.entries = this.entries.filter((entry) => entry.mod.id !== id)
    }

    has(id: string) {
      return this.mods.has(id)
    }

    get(id: string) {
      return this.mods.get(id)
    }

    list() {
      return [...this.mods.values()].sort((a, b) => this.position(a) - this.position(b))
    }

    /** Whether any loaded hook could see this event. The zero-mod fast path reads this. */
    handles(name: string) {
      return this.entries.some((entry) => nameMatches(entry.event, name))
    }

    events(id: string) {
      return [...new Set(this.entries.filter((entry) => entry.mod.id === id).map((entry) => entry.event))]
    }

    position(mod: Mod) {
      return mod.rank * 1_000_000 + (this.order.get(mod.id) ?? 0)
    }

    select(name: string, options: Pick<EmitOptions, "from" | "only">) {
      const from = options.from ? this.position(options.from) : undefined
      return this.entries
        .filter((entry) => nameMatches(entry.event, name))
        .filter((entry) => (options.only ? entry.mod.id === options.only : true))
        .filter((entry) => (from === undefined ? true : this.position(entry.mod) < from))
        .sort((a, b) => this.position(a.mod) - this.position(b.mod))
    }
  }

  const ENGINE: Origin = { plugin: "engine", tier: "core" }

  /** What a rejected `next` carries back into the hook: the engine's own cause. */
  class Downstream extends Error {
    constructor(readonly failure: Cause.Cause<unknown>) {
      super("the engine's behaviour failed")
    }
  }

  type Attempt = { ok: true; value: unknown } | { ok: false; error: unknown; info: ErrorInfo }

  const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))

  /**
   * Fire an event.
   *
   * With no matching hook this is exactly `final(event)`: the event is not
   * copied, frozen or timed. `E` and `R` are `final`'s; a hook cannot add to
   * them.
   */
  export function emit<T, E = never, R = never>(
    registry: Registry,
    name: string,
    event: any,
    final: (event: any) => Effect.Effect<T, E, R>,
    options: EmitOptions = {},
  ): Effect.Effect<T, E, R> {
    const entries = registry.select(name, options)
    if (entries.length === 0) return final(event)

    return Effect.gen(function* () {
      const services = yield* Effect.context<R>()
      const bridge = Effect.runPromiseWith(services)
      const abort = new AbortController()
      const outer = options.signal
      if (outer?.aborted) abort.abort()
      else outer?.addEventListener("abort", () => abort.abort(), { once: true })
      const origin = options.origin ?? ENGINE
      // The session a hook belongs to: the event names it, or the hook that fired this event does.
      const session = typeof event?.sessionID === "string" ? (event.sessionID as string) : scope.getStore()?.sessionID

      const run = (index: number, current: any, floor: number): Effect.Effect<any, E, R> => {
        let at = index
        while (at < entries.length) {
          const entry = entries[at]!
          if (TIER_RANK[entry.mod.tier] >= floor && matches(entry.matcher, current)) break
          at++
        }
        if (at >= entries.length) return final(current)
        return invoke(entries[at]!, at, current, floor)
      }

      const attempt = (
        hook: Hook,
        mod: Mod,
        current: any,
        next: Next,
        hookScope: Scope,
        clock: BudgetClock,
        hookAbort: AbortController,
      ) =>
        Effect.callback<Attempt>((resume) => {
          let settled = false
          const finish = (value: Attempt) => {
            if (settled) return
            settled = true
            clock.stop()
            resume(Effect.succeed(value))
          }
          clock.start(() => {
            hookAbort.abort()
            finish({
              ok: false,
              error: new Error(`exceeded ${clock.ms}ms`),
              info: { kind: "timeout", message: `exceeded ${clock.ms}ms` },
            })
          })
          try {
            const api = mod.api()
            scope.run(hookScope, () => {
              Promise.resolve()
                .then(() => hook(api, current, next))
                .then(
                  (value) => finish({ ok: true, value }),
                  (error) => finish({ ok: false, error, info: { kind: "throw", message: describe(error) } }),
                )
            })
          } catch (error) {
            finish({ ok: false, error, info: { kind: "throw", message: describe(error) } })
          }
          return Effect.sync(() => {
            settled = true
            clock.stop()
            hookAbort.abort()
          })
        })

      const invoke = (entry: Entry, at: number, current: any, floor: number): Effect.Effect<any, E, R> =>
        Effect.gen(function* () {
          const clock = new BudgetClock(options.limitMs ?? HOOK_LIMIT_MS)
          const hookAbort = new AbortController()
          const signal = AbortSignal.any([abort.signal, hookAbort.signal])
          const state: { called: boolean; exit?: Exit.Exit<any, E> } = { called: false }

          const forward = async (value: any, tier: number) => {
            state.called = true
            clock.pause()
            try {
              const exit = await bridge(Effect.exit(run(at + 1, freeze(value), Math.max(floor, tier))), {
                signal: abort.signal,
              })
              state.exit = exit
              if (Exit.isSuccess(exit)) return exit.value
              throw new Downstream(exit.cause)
            } finally {
              clock.resume()
            }
          }

          const next = Object.assign((value: any) => forward(value ?? current, floor), {
            signal,
            origin,
            budget: clock as Budget,
            to: async (value: any, tier: "append" | "builtin" | "core") => {
              if (!entry.mod.skip) {
                throw new Error(`${entry.mod.name} may not call next.to: only a mod the organization listed can`)
              }
              return forward(value ?? current, TIER_RANK[tier])
            },
          }) as Next

          const hookScope: Scope = { budget: clock, sessionID: session, signal, mod: entry.mod }
          const result = yield* attempt(entry.hook, entry.mod, current, next, hookScope, clock, hookAbort)

          let failure: ErrorInfo | undefined
          if (result.ok) {
            const bad =
              options.validate?.(result.value) ?? (result.value === undefined ? "returned undefined" : undefined)
            if (!bad) return result.value
            failure = { kind: "throw", message: `returned a result of the wrong shape: ${bad}` }
          } else {
            // The engine's own failure, passed through the hook, is not the hook's.
            if (result.error instanceof Downstream)
              return yield* Effect.failCause(result.error.failure as Cause.Cause<E>)
            failure = result.info
          }

          const reason = `${entry.event} hook skipped: ${failure.kind === "timeout" ? failure.message : `threw ${failure.message}`}`
          log.warn("mod hook failed", {
            mod: entry.mod.name,
            event: entry.event,
            kind: failure.kind,
            message: failure.message,
          })
          options.report?.({ mod: entry.mod, event: entry.event, reason })

          if (entry.onError) {
            const catchClock = new BudgetClock(options.catchLimitMs ?? CATCH_LIMIT_MS)
            const catchAbort = new AbortController()
            const handlerNext = Object.assign(
              async (value: any) => {
                const exit = await bridge(Effect.exit(run(at + 1, freeze(value ?? current), floor)), {
                  signal: abort.signal,
                })
                if (Exit.isSuccess(exit)) return exit.value
                throw new Downstream(exit.cause)
              },
              {
                signal: AbortSignal.any([abort.signal, catchAbort.signal]),
                origin,
                budget: catchClock as Budget,
                to: next.to,
                error: failure,
                called: state.called,
              },
            ) as Next
            const caught = yield* attempt(
              entry.onError,
              entry.mod,
              current,
              handlerNext,
              { ...hookScope, budget: catchClock },
              catchClock,
              catchAbort,
            )
            if (caught.ok && caught.value !== undefined) return caught.value
            if (!caught.ok) {
              if (caught.error instanceof Downstream)
                return yield* Effect.failCause(caught.error.failure as Cause.Cause<E>)
              log.warn("mod catch handler failed", {
                mod: entry.mod.name,
                event: entry.event,
                message: caught.info.message,
              })
            }
          }

          // Before `next` the hook is skipped; after it, that result stands.
          if (state.called && state.exit) {
            return Exit.isSuccess(state.exit) ? state.exit.value : yield* Effect.failCause(state.exit.cause)
          }
          return yield* run(at + 1, current, floor)
        })

      return yield* run(0, freeze(event), 0).pipe(
        Effect.onExit((exit) => Effect.sync(() => (Exit.isSuccess(exit) ? undefined : abort.abort()))),
      )
    })
  }
}
