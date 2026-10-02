import path from "path"
import { fileURLToPath } from "url"
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect"
import type { ToolDefinition } from "@nikcli-ai/plugin/tool"
import { Flag } from "@nikcli-ai/util/flag"
import { Log } from "@nikcli-ai/util/log"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState, type InstanceContext } from "@/effect"
import { Instance } from "@/project/instance"
import { ModApi } from "./api"
import { ModChain } from "./chain"
import { ModGuard } from "./guard"
import { ModUi } from "./ui"

/**
 * Mods: TypeScript functions that change how nikcli works.
 *
 * A mod is a plugin module that exports `register(on, options)`. It registers
 * hooks on named events — a tool call, a prompt, a permission check — and each
 * hook can observe the event, rewrite it, answer it in nikcli's place, or wrap
 * it. All hooks on an event form one chain in a fixed order, with the guard
 * `sec-default` first. See `ModChain` for the chain's semantics and
 * `specs/effect-tui/14-plugin-v2-architecture.md` for where this sits.
 *
 * This service owns the chain, the loaded mods and their lifetimes. The plugin
 * loader decides *which* modules are mods and hands them here; the call sites
 * in the session, tool and permission code `emit` events.
 */
export namespace Mod {
  const log = Log.create({ service: "mod" })

  export const Event = {
    /** `$.ui.log`: a dim line a mod wants in the transcript. */
    Log: BusEvent.schema(
      "mod.log",
      Schema.Struct({
        plugin: Schema.String,
        sessionID: Schema.optional(Schema.String),
        text: Schema.String,
      }),
    ),
  }

  export const UiEvent = {
    /** A mod asked to be drawn again. A newer one says everything an older one did. */
    Invalidate: BusEvent.schema(
      "mod.ui.invalidate",
      Schema.Struct({ component: Schema.optional(Schema.String), requestID: Schema.optional(Schema.String) }),
      { delivery: "snapshot" },
    ),
    /** The set of panes mods have open changed; read it again. */
    Panes: BusEvent.schema("mod.ui.panes", Schema.Struct({}), { delivery: "snapshot" }),
  }

  export class LoadRefused extends Schema.TaggedError<LoadRefused>()("ModLoadRefused", {
    plugin: Schema.String,
    reason: Schema.String,
  }) {
    override get message() {
      return `Mod ${this.plugin} was not loaded: ${this.reason}`
    }
  }

  export class RegisterFailed extends Schema.TaggedError<RegisterFailed>()("ModRegisterFailed", {
    plugin: Schema.String,
    reason: Schema.String,
  }) {
    override get message() {
      return `Mod ${this.plugin} failed to register: ${this.reason}`
    }
  }

  /** A module is a mod when it exports a `register` function. */
  export function isMod(module: unknown): module is { register: (on: unknown, options: unknown) => void } {
    return (
      typeof module === "object" && module !== null && typeof (module as { register?: unknown }).register === "function"
    )
  }

  export interface LoadInput {
    /** The plugin specifier, as configured. */
    id: string
    /** Canonical name, as `Config.getPluginName` derives it. */
    name: string
    module: Record<string, unknown>
    options?: Record<string, unknown>
    /** The module's source text, read for `plugin.register` and refused-when-unreadable. Absent only for built-ins. */
    source?: string
    /** The plugin's directory. */
    root?: string
    /** The module is in an organization-managed directory. */
    org?: boolean
    /** Built into nikcli rather than installed. */
    builtin?: boolean
  }

  export interface Info {
    id: string
    name: string
    tier: ModChain.Tier
    rank: number
    events: string[]
    tools: string[]
    commands: string[]
  }

  export interface Interface {
    /**
     * Fire an event through the chain. With no matching hook this is
     * `final(event)`, untouched. `E` and `R` are `final`'s: a hook cannot add
     * to them, and a failure of `final` always arrives on the typed channel.
     */
    readonly emit: <T, E = never, R = never>(
      name: string,
      event: unknown,
      final: (event: any) => Effect.Effect<T, E, R>,
      options?: ModChain.EmitOptions,
    ) => Effect.Effect<T, E, R>
    /** Whether any loaded hook could see this event. */
    readonly handles: (name: string) => Effect.Effect<boolean>
    readonly load: (input: LoadInput) => Effect.Effect<Info, LoadRefused | RegisterFailed>
    readonly unload: (id: string) => Effect.Effect<void>
    readonly list: () => Effect.Effect<Info[]>
    /** Tools a loaded mod registered with `$.tool.register`, for the tool registry. */
    readonly tools: () => Effect.Effect<Record<string, ToolDefinition>>
    /** One mod's live tool map: the plugin adapter hands this very object to the tool registry. */
    readonly toolsOf: (id: string) => Effect.Effect<Record<string, ToolDefinition>>
    /** Specifiers of the organization's own mods, from the managed directories. */
    readonly orgSpecs: () => Effect.Effect<string[]>
    /**
     * Ask the mods what to draw at a render site. `tree` is a drawing (`null` for nothing), absent
     * means "draw the default"; `props` are the site's props as the chain left them.
     */
    readonly render: (input: {
      component: string
      requestId?: string
      sessionID?: string
      props: Record<string, unknown>
      viewport?: { columns: number; rows: number }
    }) => Effect.Effect<{ tree?: ModUi.Node; props?: Record<string, unknown> }>
    /** A control a mod drew was used: `ui.press`, `ui.input`, `ui.select` or `ui.close` among the mods. */
    readonly uiEvent: (input: {
      kind: "press" | "input" | "select" | "close" | "message"
      key?: string
      value?: unknown
      submit?: boolean
      component?: string
      requestId?: string
      sessionID?: string
    }) => Effect.Effect<{ handled: boolean }>
    readonly panes: () => Effect.Effect<ModUi.PaneInfo[]>
    /** A command a mod registered with `$.command.register`. */
    readonly command: (name: string) => Effect.Effect<ModApi.Command | undefined>
    readonly commands: () => Effect.Effect<Array<{ name: string; description?: string }>>
  }

  export class Service extends Context.Service<Service, Interface>()("@nikcli/Mod") {}

  type Live = {
    mod: ModChain.Mod
    scope: Scope.Closeable
    tools: Record<string, ToolDefinition>
  }

  type State = {
    registry: ModChain.Registry
    resolved: ModGuard.Resolved
    live: Map<string, Live>
    commands: Map<string, ModApi.Command & { owner: string }>
    /** Panes mods have open, by id. */
    panes: Map<string, ModUi.PaneInfo & { owner: string }>
    /** Per-mod values that survive a reload; gone with the process. */
    memory: Map<string, Map<string, unknown>>
    /** Mods that have loaded before, to tell a reload from a start. */
    seen: Set<string>
  }

  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  }

  /** Does a configured plugin name match an entry of a policy list (`name` or `name@marketplace`)? */
  const listed = (list: readonly string[] | undefined, name: string) =>
    (list ?? []).findIndex((entry) => entry === name || entry.split("@")[0] === name)

  const refusal = (result: unknown) => {
    if (!result || typeof result !== "object") return "needs an object"
    const refuse = (result as { refuse?: unknown }).refuse
    return refuse === undefined || typeof refuse === "string" ? undefined : "refuse must be a string"
  }

  const apiResult = (result: unknown) =>
    result && typeof result === "object" && ("value" in result || "deny" in result)
      ? undefined
      : "needs { value } or { deny }"

  /** Publish a UI event from outside any instance scope (a timer, a hook that outlived its turn). */
  async function publishUi(ctx: InstanceContext, def: any, properties: unknown) {
    await Instance.provide({
      directory: ctx.directory,
      fn: async () => {
        const { Bus } = await import("@/bus")
        await Bus.publish(def, properties as never)
      },
    })
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make<State>(
        Effect.fn("Mod.state")(function* (ctx) {
          const resolved = yield* ModGuard.read()
          const s: State = {
            registry: new ModChain.Registry(),
            resolved,
            live: new Map(),
            commands: new Map(),
            panes: new Map(),
            memory: new Map(),
            seen: new Set(),
          }

          // The guard is a mod like any other, registered through the same `on`.
          // A managed `prependPlugins` list that omits it leaves it out, and places it when it names it.
          const prepend = resolved.policy.prependPlugins
          const guardAt = prepend === undefined ? 0 : listed(prepend, ModGuard.GUARD_ID)
          if (guardAt >= 0) {
            s.registry.add(
              {
                id: ModGuard.GUARD_ID,
                name: "sec-default",
                tier: "builtin",
                rank: guardAt,
                skip: false,
                api: () => ({}),
              },
              ModGuard.register(resolved),
            )
          }

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              // The instance is going away: every hook on `session.end` gets 1.5 s between them,
              // then each mod's scope is closed. A hook that hangs cannot hold shutdown.
              yield* Effect.exit(
                ModChain.emit(s.registry, "session.end", { reason: "other" }, () => Effect.succeed({}), {
                  limitMs: 1_500,
                  validate: () => undefined,
                }),
              )
              yield* Effect.forEach([...s.live.values()], (live) => Scope.close(live.scope, Exit.void), {
                discard: true,
              })
            }),
          )
          return s
        }),
      )
      const getState = () => InstanceState.get(state)

      const info = (s: State, live: Live): Info => ({
        id: live.mod.id,
        name: live.mod.name,
        tier: live.mod.tier,
        rank: live.mod.rank,
        events: s.registry.events(live.mod.id),
        tools: Object.keys(live.tools),
        commands: [...s.commands.values()]
          .filter((command) => command.owner === live.mod.id)
          .map((command) => command.name),
      })

      const emit: Interface["emit"] = (name, event, final, options) =>
        getState().pipe(Effect.flatMap((s) => ModChain.emit(s.registry, name, event, final, options)))

      const unload = Effect.fn("Mod.unload")(function* (id: string) {
        const s = yield* getState()
        const ctx0 = yield* InstanceState.context
        const live = s.live.get(id)
        if (!live) return
        // Revoke before disposing: the chain stops seeing the mod first, so a
        // late hook of the old generation cannot run beside the new one.
        s.registry.remove(id)
        s.live.delete(id)
        for (const [name, command] of s.commands) if (command.owner === id) s.commands.delete(name)
        let closed = false
        for (const [paneId, pane] of s.panes) {
          if (pane.owner !== id) continue
          s.panes.delete(paneId)
          closed = true
        }
        if (closed) yield* Effect.promise(() => publishUi(ctx0, UiEvent.Panes, {}))
        yield* Scope.close(live.scope, Exit.void)
      })

      const load = Effect.fn("Mod.load")(function* (input: LoadInput) {
        const s = yield* getState()
        const ctx = yield* InstanceState.context
        const { policy } = s.resolved

        if (!input.builtin && (Flag.modsDisabled() || policy.disableAllMods)) {
          return yield* new LoadRefused({ plugin: input.name, reason: "mods are turned off" })
        }
        const module = input.module
        if (!isMod(module)) {
          return yield* new RegisterFailed({ plugin: input.name, reason: "the module does not export register()" })
        }

        // The organization's own mods live in a managed directory the machine's owner controls.
        const org =
          input.org ??
          (input.root !== undefined && s.resolved.orgDirs.some((dir) => inside(path.join(dir, "plugins"), input.root!)))

        // Where the mod sits. A managed list can only place a mod the organization owns.
        const at = org ? listed(policy.prependPlugins, input.name) : -1
        const after = org ? listed(policy.appendPlugins, input.name) : -1
        const tier: ModChain.Tier = input.builtin ? "builtin" : org ? (after >= 0 ? "append" : "prepend") : "user"
        const rank = input.builtin ? 300 : after >= 0 ? 200 + after : org ? (at >= 0 ? at : 50) : 100

        // What the module asks for, read without running it. A module that cannot be read is refused.
        const uses = input.source === undefined ? undefined : ModGuard.analyze(input.source)
        if (!input.builtin) {
          if (uses === undefined) {
            return yield* new LoadRefused({
              plugin: input.name,
              reason: "its source could not be read to review what it does",
            })
          }
          if (uses.unreadable.length > 0) {
            return yield* new LoadRefused({
              plugin: input.name,
              reason: `it uses the mods API in a way that cannot be reviewed: ${uses.unreadable.join("; ")}`,
            })
          }
          const verdict: { refuse?: string } = yield* ModChain.emit(
            s.registry,
            "plugin.register",
            { plugin: input.name, tier, uses },
            () => Effect.succeed({} as { refuse?: string }),
            { validate: refusal },
          )
          if (verdict.refuse !== undefined) {
            return yield* new LoadRefused({ plugin: input.name, reason: verdict.refuse })
          }
        }

        // A reload replaces the previous generation; it never runs beside it.
        yield* unload(input.id)

        const scope = yield* Scope.make()
        const tools: Record<string, ToolDefinition> = {}
        const memory = s.memory.get(input.id) ?? new Map<string, unknown>()
        s.memory.set(input.id, memory)

        const mod: ModChain.Mod = {
          id: input.id,
          name: input.name,
          tier,
          rank,
          skip: org && (at >= 0 || after >= 0),
          api: () => ({}),
        }
        const api = ModApi.make({
          ctx,
          mod,
          root: input.root,
          options: input.options ?? {},
          scope,
          tools,
          commands: s.commands,
          memory,
          emit: (name, event, impl) =>
            Effect.runPromise(
              ModChain.emit(
                s.registry,
                name,
                event,
                (e) =>
                  Effect.tryPromise({
                    try: async () => ({ value: await impl(e) }) as { value?: unknown; deny?: string },
                    catch: (error) => error,
                  }),
                { from: mod, origin: { plugin: mod.name, tier: mod.tier }, validate: apiResult },
              ).pipe(Effect.map((result) => result as { value?: unknown; deny?: string })),
            ),
          inInstance: async (fn) => await Instance.provide({ directory: ctx.directory, fn }),
          panes: s.panes,
          changed: (kind, detail) =>
            void (
              kind === "panes" ? publishUi(ctx, UiEvent.Panes, {}) : publishUi(ctx, UiEvent.Invalidate, detail ?? {})
            ).catch((error) => log.warn("mod ui event failed", { error: String(error) })),
        })
        mod.api = () => api

        const registered = yield* Effect.try({
          try: () => s.registry.add(mod, (on) => module.register(on, input.options ?? {})),
          catch: (error) =>
            new RegisterFailed({ plugin: input.name, reason: error instanceof Error ? error.message : String(error) }),
        }).pipe(Effect.tapError(() => Scope.close(scope, Exit.void)))

        const live: Live = { mod, scope, tools }
        s.live.set(input.id, live)
        log.info("mod loaded", { mod: input.name, tier, rank, hooks: registered })

        // Once per mod, before the first prompt, and again after a reload of that mod.
        const reload = s.seen.has(input.id)
        s.seen.add(input.id)
        yield* ModChain.emit(
          s.registry,
          "session.start",
          { reason: reload ? "reload" : "startup" },
          () => Effect.succeed({}),
          {
            only: input.id,
            origin: { plugin: "engine", tier: "core" },
            validate: () => undefined,
          },
        )
        return info(s, live)
      })

      const render: Interface["render"] = Effect.fn("Mod.render")(function* (input) {
        const s = yield* getState()
        if (!s.registry.handles("ui.render")) return {}
        const event = {
          component: input.component,
          requestId: input.requestId ?? "",
          surface: "terminal",
          sessionID: input.sessionID,
          props: input.props,
          viewport: input.viewport,
        }
        const result: any = yield* ModChain.emit(s.registry, "ui.render", event, (e) => Effect.succeed(e), {
          validate: (r) =>
            r && typeof r === "object" ? undefined : "needs an object: a drawing ({ tree }) or the event",
        })
        if ("tree" in result && result.tree !== undefined) {
          const bad = result.tree === null ? undefined : ModUi.validate(result.tree)
          if (bad) {
            log.warn("a mod drew a tree a client cannot draw", { component: input.component, problem: bad })
            return {}
          }
          return { tree: result.tree as ModUi.Node }
        }
        return { props: (result.props ?? input.props) as Record<string, unknown> }
      })

      const uiEvent: Interface["uiEvent"] = Effect.fn("Mod.uiEvent")(function* (input) {
        const s = yield* getState()
        const name = `ui.${input.kind}`
        if (!s.registry.handles(name)) return { handled: false }
        const result: any = yield* ModChain.emit(s.registry, name, input, () => Effect.succeed({ handled: false }), {
          validate: (r) => (r && typeof r === "object" ? undefined : "needs an object"),
        })
        return { handled: result.handled === true }
      })

      return Service.of({
        emit,
        handles: (name) => getState().pipe(Effect.map((s) => s.registry.handles(name))),
        load,
        unload,
        list: () => getState().pipe(Effect.map((s) => [...s.live.values()].map((live) => info(s, live)))),
        tools: () =>
          getState().pipe(
            Effect.map(
              (s) =>
                Object.assign({}, ...[...s.live.values()].map((live) => live.tools)) as Record<string, ToolDefinition>,
            ),
          ),
        render,
        uiEvent,
        panes: () =>
          getState().pipe(Effect.map((s) => [...s.panes.values()].map(({ owner: _owner, ...pane }) => pane))),
        toolsOf: (id) => getState().pipe(Effect.map((s) => s.live.get(id)?.tools ?? {})),
        orgSpecs: () => getState().pipe(Effect.flatMap((s) => ModGuard.orgSpecs(s.resolved.orgDirs))),
        command: (name) => getState().pipe(Effect.map((s) => s.commands.get(name))),
        commands: () =>
          getState().pipe(
            Effect.map((s) => [...s.commands.values()].map(({ name, description }) => ({ name, description }))),
          ),
      })
    }),
  )

  export const defaultLayer = layer

  /** What a Promise-side call site's behaviour threw, carried through the typed channel and unwrapped after. */
  class Thrown {
    constructor(readonly error: unknown) {}
  }

  /**
   * Fire an event from Promise-side code (the session and tool code that still is).
   *
   * `final` is nikcli's own behaviour. If it throws, that exact error is
   * rethrown here after the chain has seen the failure, so a caller that
   * catches a tool's error keeps catching the same error with or without mods.
   * A hook never changes which error that is.
   */
  export async function emitPromise<T>(
    name: string,
    event: unknown,
    final: (event: any) => Promise<T>,
    options?: ModChain.EmitOptions,
  ): Promise<T> {
    const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
    try {
      return await runPromiseWithLayer(
        defaultLayer,
        withCurrentInstance(
          Effect.gen(function* () {
            const mod = yield* Service
            return yield* mod.emit(
              name,
              event,
              (e) => Effect.tryPromise({ try: () => final(e), catch: (error) => new Thrown(error) }),
              options,
            )
          }),
        ),
      )
    } catch (error) {
      if (error instanceof Thrown) throw error.error
      throw error
    }
  }

  /** The directory a plugin specifier lives in, when it is a local file. */
  export function rootOf(spec: string) {
    if (!spec.startsWith("file://")) return undefined
    return path.dirname(fileURLToPath(spec))
  }

  // ---------------------------------------------------------------------------
  // tool.call

  /** The engine's own failure, carried on the result so it is rethrown unchanged if no mod answers instead. */
  const FAILED = Symbol.for("nikcli.mod.tool-call-failed")

  /** Fields of a `tool.call` event that are nikcli's, not the tool's arguments. */
  const META = new Set(["tool", "sessionID", "agent", "messageID", "callID", "input"])

  const PERMISSION_ERRORS = new Set([
    "PermissionRejectedError",
    "PermissionCorrectedError",
    "PermissionDeniedError",
    "PermissionBlockedError",
  ])

  export interface ToolCall {
    tool: string
    sessionID: string
    agent: string
    messageID: string
    callID: string
    args: Record<string, unknown>
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)

  /**
   * The event a `tool.call` hook sees: the tool's arguments as top-level
   * fields (`e.command` for bash), and nikcli's own fields beside them.
   * An argument whose name collides with one of nikcli's stays reachable
   * through `e.input`, which always holds the arguments untouched.
   */
  function toolEvent(call: ToolCall) {
    const event: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(call.args)) if (!META.has(key)) event[key] = value
    return {
      ...event,
      tool: call.tool,
      sessionID: call.sessionID,
      agent: call.agent,
      messageID: call.messageID,
      callID: call.callID,
      input: call.args,
    }
  }

  /** The arguments a hook left in the event: `input`, overridden by whatever it changed at the top level. */
  function toolArgs(event: Record<string, unknown>) {
    const args: Record<string, unknown> = { ...(isRecord(event.input) ? event.input : {}) }
    for (const [key, value] of Object.entries(event)) if (!META.has(key)) args[key] = value
    return args
  }

  /**
   * Run one tool call through the `tool.call` chain.
   *
   * `next(e)` runs nikcli's own behaviour — the permission check and then the
   * tool — and resolves to its result, or to `{ isError }` / `{ deny }` when it
   * failed. A hook can pass the event on, change its arguments, call `next`
   * again to retry, or answer without calling it:
   *
   * - `{ deny: reason }` — the tool does not run, the model reads the reason;
   * - `{ result }` — the tool does not run, the model reads this result.
   *
   * If the behaviour failed and no hook replaced its result, the **original**
   * error is rethrown here, so every caller keeps catching what it always did.
   * With no hook on the event this is `run(call.args)` and nothing else.
   */
  export async function toolCall<T extends object>(
    call: ToolCall,
    run: (args: Record<string, unknown>) => Promise<T>,
    answer: (text: string) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const out: any = await emitPromise(
      "tool.call",
      toolEvent(call),
      async (event) => {
        try {
          return await run(toolArgs(event))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const refused = error instanceof Error && PERMISSION_ERRORS.has((error as { _tag?: string })._tag ?? "")
          return { ...(refused ? { deny: message } : { isError: true, output: message }), [FAILED]: error }
        }
      },
      {
        signal,
        validate: (result) =>
          isRecord(result) ? undefined : "needs an object: the tool's result, { deny } or { result }",
      },
    )
    if (FAILED in out) {
      // Still nikcli's own failure: nothing replaced it.
      throw out[FAILED]
    }
    if (typeof out.deny === "string") return answer(out.deny)
    if ("result" in out && Object.keys(out).length === 1) {
      return typeof out.result === "string" ? answer(out.result) : (out.result as T)
    }
    return out as T
  }

  // ---------------------------------------------------------------------------
  // prompt.submit, tool.describe

  /** A `prompt.submit` mod returned `{ drop }`: the prompt is not sent. */
  export class PromptDropped extends Schema.TaggedError<PromptDropped>()("ModPromptDropped", {
    reason: Schema.String,
  }) {
    override get message() {
      return `The prompt was not sent: ${this.reason}`
    }
  }

  /** Whether a loaded mod hooks this event. The guard is always loaded, so ask about the event you will fire. */
  export async function handles(name: string): Promise<boolean> {
    const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
    return runPromiseWithLayer(
      defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const mod = yield* Service
          return yield* mod.handles(name)
        }),
      ),
    )
  }

  /**
   * A prompt about to be sent. A mod can rewrite its text (`next({ ...e, text })`),
   * add text only the model reads (`next({ ...e, context: [...e.context, line] })`),
   * or stop it (`{ drop: reason }`).
   */
  export async function promptSubmit(input: { sessionID: string; agent: string; text: string }) {
    const out: any = await emitPromise("prompt.submit", { ...input, context: [] as string[] }, async (event) => event, {
      validate: (result) =>
        isRecord(result) && (typeof result.drop === "string" || typeof result.text === "string")
          ? undefined
          : "needs the event (with text) or { drop: reason }",
    })
    if (typeof out.drop === "string") throw new PromptDropped({ reason: out.drop })
    return {
      text: out.text as string,
      context: Array.isArray(out.context) ? (out.context as unknown[]).map(String) : [],
    }
  }

  /** The description of a tool as the model reads it, once per tool when its schema is first sent. */
  export async function describe(tool: string, description: string): Promise<string> {
    const out: any = await emitPromise(
      "tool.describe",
      { tool, description },
      async (event) => ({ description: event.description }),
      {
        validate: (result) =>
          isRecord(result) && typeof result.description === "string" ? undefined : "needs { description }",
      },
    )
    return out.description as string
  }

  // ---------------------------------------------------------------------------
  // commands

  /** A command a mod registered with `$.command.register`, if there is one by that name. */
  export async function commandOf(name: string): Promise<ModApi.Command | undefined> {
    const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
    return runPromiseWithLayer(
      defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const mod = yield* Service
          return yield* mod.command(name)
        }),
      ),
    )
  }

  export async function commandList(): Promise<Array<{ name: string; description?: string }>> {
    const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
    return runPromiseWithLayer(
      defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const mod = yield* Service
          return yield* mod.commands()
        }),
      ),
    )
  }

  /** What a mod command's `run` may return: text for the transcript, or nothing. */
  export function commandText(value: unknown): string | undefined {
    if (typeof value === "string") return value
    if (isRecord(value) && typeof value.text === "string") return value.text
    return undefined
  }

  /**
   * A command about to run. A mod can rewrite its arguments (`next({ ...e, arguments })`),
   * answer with `{ text }` or `{}` and no model turn, or let it run. `kind` says whether
   * the command is a template nikcli expands into a prompt, or one a mod registered and
   * runs at once with no model turn at all.
   */
  export async function commandRun<T>(
    event: { name: string; arguments: string; sessionID: string; kind: "template" | "mod" },
    final: (event: { name: string; arguments: string; sessionID: string; kind: string }) => Promise<T>,
  ): Promise<T | { text?: string }> {
    return emitPromise("command.run", event, final, {
      validate: (result) => (isRecord(result) ? undefined : "needs { text }, {} or the command's own result"),
    })
  }

  // ---------------------------------------------------------------------------
  // turns

  const object = (what: string) => (result: unknown) => (isRecord(result) ? undefined : `needs ${what}`)

  /** A turn is everything nikcli does in answer to one prompt. */
  export async function turnStart(event: { sessionID: string; turnId: string; agent?: string }) {
    if (!(await handles("turn.start"))) return
    await emitPromise("turn.start", event, async (e) => e, { validate: object("the event") })
  }

  /**
   * One request is about to go to the model. A mod can send it to a different model
   * (`next({ ...e, model: "provider/model" })`). Fires before the
   * request is built, so the step runs on whatever the chain settles on. The model is
   * what a hook can change; `variant` is there to read.
   */
  export async function turnStep(event: {
    sessionID: string
    turnId: string
    step: number
    agent: string
    model: string
    variant?: string
  }) {
    if (!(await handles("turn.step"))) return event
    const out: any = await emitPromise("turn.step", event, async (e) => e, {
      validate: (result) =>
        isRecord(result) && typeof result.model === "string" ? undefined : "needs the event with a model string",
    })
    return { ...event, model: out.model as string, variant: out.variant as string | undefined }
  }

  /** The turn ended, answered or interrupted. `answer` is the final text. */
  export async function turnComplete(event: {
    sessionID: string
    turnId: string
    answer: string
    durationMs: number
    isAborted: boolean
    usage?: Record<string, unknown>
  }) {
    if (!(await handles("turn.complete"))) return
    await emitPromise("turn.complete", event, async (e) => e, { validate: object("the event or { text }") })
  }

  // ---------------------------------------------------------------------------
  // the system prompt

  export type PromptSection = { id: string; text: string }

  /**
   * The system prompt as named sections: `agent` or `provider` (the base prompt), `system`
   * (what the caller added) and `user` (the last message's own). `prompt.section` fires once for
   * each and may rewrite its `text`, or answer `{ text: null }` to leave it out; `prompt.compose`
   * then sees the list and may return `{ sections }` to reorder, add or remove. The provider's
   * header is not a section: some providers reject a request without it.
   *
   * With no hook on either event the sections come back as they went in. Text that changes
   * between requests invalidates the prompt cache, so a mod should keep it stable.
   */
  export async function promptSections(sections: PromptSection[]): Promise<PromptSection[]> {
    let out = sections
    if (await handles("prompt.section")) {
      const next: PromptSection[] = []
      for (const section of out) {
        const result: any = await emitPromise(
          "prompt.section",
          { name: section.id, text: section.text },
          async (e) => ({ text: e.text as string | null }),
          {
            validate: (r) =>
              isRecord(r) && (r.text === null || typeof r.text === "string")
                ? undefined
                : "needs { text: string | null }",
          },
        )
        if (result.text !== null) next.push({ id: section.id, text: result.text })
      }
      out = next
    }
    if (await handles("prompt.compose")) {
      const result: any = await emitPromise(
        "prompt.compose",
        { sections: out.map((section) => ({ id: section.id, text: section.text, scope: "system" })) },
        async (e) => ({ sections: e.sections as Array<{ id: string; text: string }> }),
        {
          validate: (r) =>
            isRecord(r) &&
            Array.isArray(r.sections) &&
            r.sections.every(
              (section) => isRecord(section) && typeof section.id === "string" && typeof section.text === "string",
            )
              ? undefined
              : "needs { sections: [{ id, text }] }",
        },
      )
      out = (result.sections as Array<{ id: string; text: string }>).map(({ id, text }) => ({ id, text }))
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // subagents

  /** Whether a subagent type is offered to the model. A mod answers `{ isOffered: false }` to withhold one. */
  export async function agentOffered(agent: { name: string; description?: string }): Promise<boolean> {
    const out: any = await emitPromise(
      "agent.offer",
      { agent: agent.name, description: agent.description ?? "" },
      async () => ({ isOffered: true }),
      { validate: (r) => (isRecord(r) && typeof r.isOffered === "boolean" ? undefined : "needs { isOffered }") },
    )
    return out.isOffered
  }

  /**
   * A subagent is about to start. A mod can refuse it (`{ deny: reason }`, which the model reads
   * as the tool's result) or choose its model (`next({ ...e, model: "provider/model" })`).
   */
  export async function agentSpawn(event: {
    sessionID: string
    agent: string
    description: string
    prompt: string
    model?: string
  }): Promise<{ deny?: string; model?: string }> {
    const out: any = await emitPromise("agent.spawn", event, async (e) => ({ model: e.model as string | undefined }), {
      validate: (r) =>
        isRecord(r) && (typeof r.deny === "string" || r.model === undefined || typeof r.model === "string")
          ? undefined
          : "needs { deny } or { model }",
    })
    return { deny: typeof out.deny === "string" ? out.deny : undefined, model: out.model }
  }
}
