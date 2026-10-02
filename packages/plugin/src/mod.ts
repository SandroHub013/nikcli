/**
 * Types for writing a nikcli mod.
 *
 * A mod is a plugin module that exports `register(on, options)`. It registers
 * hooks on named events; each hook receives the mods API (`$`), the event
 * (`e`, deeply frozen — pass a changed copy to `next`) and `next`, the rest of
 * the chain. A hook can:
 *
 * - **observe**: do its work and `return next(e)`;
 * - **rewrite**: `return next({ ...e, text: e.text.trim() })`;
 * - **answer**: return a result without calling `next`;
 * - **wrap**: `const result = await next(e)`, then return a changed result.
 *
 * ```ts
 * import type { ModRegister } from "@nikcli-ai/plugin/mod"
 *
 * export const register: ModRegister = (on) => {
 *   on("tool.call", { tool: "bash" }, async ($, e, next) => {
 *     if (/git push .*--force/.test(e.command)) return { deny: "Force pushes are not allowed here." }
 *     return next(e)
 *   })
 * }
 * ```
 *
 * Hooks on one event run in a fixed order: the guard `sec-default`, the
 * organization's mods, mods a user installed (config order), the organization's
 * `appendPlugins`, then built-in mods. The first is outermost: it sees the
 * event first and the result last.
 *
 * A hook that throws, times out (10 s of its own time — time inside `next` or
 * a `$` call does not count) or returns the wrong shape is skipped; add
 * `.catch(handler)` to fail closed instead.
 */

export type ModTier = "prepend" | "user" | "append" | "builtin"

export type ModOrigin = { plugin: string; tier: ModTier | "core" }

export interface ModNext<Event, Result> {
  (event: Event): Promise<Result>
  /** Aborts when the event is abandoned or this hook times out. */
  readonly signal: AbortSignal
  /** Who fired the event; nikcli itself is `{ plugin: "engine", tier: "core" }`. */
  readonly origin: ModOrigin
  readonly budget: { readonly ms: number; readonly remainingMs: number }
  /** Skip to a later tier. Only a mod the organization lists in `prependPlugins`/`appendPlugins` may call it. */
  to(event: Event, tier: "append" | "builtin" | "core"): Promise<Result>
  /** In a `.catch` handler only. */
  readonly error?: { kind: "throw" | "timeout"; message: string }
  /** In a `.catch` handler only: whether the failed hook had already called `next`. */
  readonly called?: boolean
}

// -----------------------------------------------------------------------------
// Drawing

export type ModNode = ModElement | string | number | false | null | undefined

/** What a mod draws. Plain data: a `Button` carries a `key`, and pressing it sends `ui.press { key }` to the mods. */
export type ModElement =
  | {
      type: "Box"
      key?: string
      props: {
        direction?: "row" | "column"
        gap?: number
        padding?: number
        margin?: number
        width?: number | string
        height?: number
        borderStyle?: "single" | "double" | "round" | "bold"
        backgroundColor?: string
        justifyContent?: "flex-start" | "center" | "flex-end" | "space-between"
        alignItems?: "flex-start" | "center" | "flex-end"
      }
      children: ModNode[]
    }
  | {
      type: "Text"
      key?: string
      props: {
        color?: string
        backgroundColor?: string
        bold?: boolean
        italic?: boolean
        underline?: boolean
        dimColor?: boolean
        inverse?: boolean
        wrap?: "wrap" | "none"
      }
      children: ModNode[]
    }
  | {
      type: "Button"
      key: string
      props: { label: string; hotkey?: string; plain?: boolean; dimColor?: boolean; autoFocus?: boolean }
    }
  | { type: "Link"; props: { href: string; label?: string } }
  | { type: "Code"; props: { text: string; language?: string } }
  | { type: "Markdown"; key?: string; props: { text: string; dimColor?: boolean } }
  | {
      type: "Input"
      key: string
      props: { label?: string; placeholder?: string; value?: string; submitLabel?: string; autoFocus?: boolean }
    }
  | {
      type: "Select"
      key: string
      props: { label?: string; options: { value: string; label?: string }[]; value?: string }
    }

/** The constructors `$.ui.resolve(e)` returns. `Box(props, ...children)`, `Text("hi")`, `Button({ key, label })`. */
export interface ModElements {
  Box(props?: Record<string, unknown>, ...children: ModNode[]): ModElement
  Box(...children: ModNode[]): ModElement
  Text(props?: Record<string, unknown>, ...children: ModNode[]): ModElement
  Text(...children: ModNode[]): ModElement
  Button(props: {
    key: string
    label: string
    hotkey?: string
    plain?: boolean
    dimColor?: boolean
    autoFocus?: boolean
  }): ModElement
  Link(props: { href: string; label?: string }): ModElement
  Code(props: { text: string; language?: string }): ModElement
  Markdown(props: { text: string; key?: string; dimColor?: boolean }): ModElement
  Input(props: {
    key: string
    label?: string
    placeholder?: string
    value?: string
    submitLabel?: string
    autoFocus?: boolean
  }): ModElement
  Select(props: {
    key: string
    label?: string
    options: { value: string; label?: string }[]
    value?: string
  }): ModElement
}

// -----------------------------------------------------------------------------
// Events

/** What a `tool.call` hook sees. The tool's arguments are top-level fields (`e.command` for `bash`). */
export type ToolCallEvent = {
  readonly tool: string
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly callID: string
  /** The arguments, untouched. An argument named like one of the fields above is only reachable here. */
  readonly input: Readonly<Record<string, unknown>>
  readonly [argument: string]: unknown
}

/** A tool's result as `next(e)` resolves it. A failed call has `isError`; a refused one has `deny`. */
export type ToolCallResult =
  | { title?: string; output: string; metadata?: Record<string, unknown>; isError?: boolean; [key: string]: unknown }
  | { deny: string }
  | { result: string | Record<string, unknown> }

export type ToolCheckEvent = {
  readonly tool: string
  readonly patterns: readonly string[]
  readonly input: Readonly<Record<string, unknown>>
  /** What the permission rules decided. The guard reads this to keep a `deny` rule a deny. */
  readonly rule: "allow" | "ask" | "deny"
  readonly sessionID: string
  readonly agent?: string
  readonly callID?: string
}
export type ToolCheckResult = { decision: "allow" | "ask" | "deny"; reason?: string }

export type ToolDescribeEvent = { readonly tool: string; readonly description: string }
export type ToolDescribeResult = { description: string }

export type PromptSubmitEvent = {
  readonly sessionID: string
  readonly agent: string
  readonly text: string
  /** Text only the model reads, after the prompt. */
  readonly context: readonly string[]
}
export type PromptSubmitResult = PromptSubmitEvent | { drop: string }

export type SessionStartEvent = { readonly reason: "startup" | "reload" }

export type PluginRegisterEvent = {
  readonly plugin: string
  readonly tier: ModTier
  /** What the module asks for, read without running it (`nikcli plugin validate` prints the same). */
  readonly uses: {
    readonly hooks: readonly string[]
    readonly calls: readonly string[]
    readonly envReads: readonly string[]
    readonly envWrites: readonly string[]
    readonly unreadable: readonly string[]
  }
}
export type PluginRegisterResult = Record<string, never> | { refuse: string }

/** The result of a `$` call seen as an event: `{ value }` to answer it, `{ deny }` to refuse it. */
export type ApiCallResult = { value: unknown } | { deny: string }

export type SessionEndEvent = { readonly reason: "other" }

export type PromptSectionEvent = { readonly name: string; readonly text: string }
export type PromptSectionResult = { text: string | null }
export type PromptComposeEvent = {
  readonly sections: readonly { readonly id: string; readonly text: string; readonly scope: string }[]
}
export type PromptComposeResult = { sections: { id: string; text: string }[] }

export type CommandRunEvent = {
  readonly name: string
  readonly arguments: string
  readonly sessionID: string
  /** `mod` for a command a mod registered, `template` for one nikcli expands into a prompt. */
  readonly kind: "template" | "mod"
}
export type CommandRunResult = { text?: string } | Record<string, unknown>

export type TurnStartEvent = { readonly sessionID: string; readonly turnId: string }
export type TurnStepEvent = {
  readonly sessionID: string
  readonly turnId: string
  readonly step: number
  readonly agent: string
  /** `provider/model`. A hook that passes a changed copy sends this request to that model. */
  readonly model: string
  readonly variant?: string
}
export type TurnCompleteEvent = {
  readonly sessionID: string
  readonly turnId: string
  readonly answer: string
  readonly durationMs: number
  readonly isAborted: boolean
  readonly usage?: Record<string, unknown>
}

export type AgentOfferEvent = { readonly agent: string; readonly description: string }
export type AgentOfferResult = { isOffered: boolean }
export type AgentSpawnEvent = {
  readonly sessionID: string
  readonly agent: string
  readonly description: string
  readonly prompt: string
  readonly model?: string
}
export type AgentSpawnResult = { model?: string } | { deny: string }

/** A render site. `AbovePrompt` is the band above the prompt; `Pane` is a pane opened with `$.ui.open`. */
export type UiRenderEvent = {
  /**
   * `AbovePrompt` and `Pane` are drawn by mods alone. `ToolUse` (a tool call's row), `UserMessage`,
   * `AssistantMessage` and `Spinner` (the reasoning line) are drawn by nikcli: answer `{ tree }` to
   * replace one, or pass a changed `props` (`Spinner` takes `props.word`) to adjust it.
   */
  readonly component: "AbovePrompt" | "Pane" | "ToolUse" | "UserMessage" | "AssistantMessage" | "Spinner"
  /** `band` for `AbovePrompt`; the pane's id for `Pane`; the call id for `ToolUse`; the message id for a message. */
  readonly requestId: string
  readonly surface: "terminal"
  readonly sessionID?: string
  readonly props: Readonly<Record<string, unknown>>
  readonly viewport?: { readonly columns: number; readonly rows: number }
}
/** Answer `{ tree }` to draw it (`null` for nothing), or pass the event on to draw nothing of your own. */
export type UiRenderResult = { tree: ModNode } | UiRenderEvent

export type UiControlEvent = {
  readonly key?: string
  readonly value?: string
  readonly submit?: boolean
  readonly component?: string
  readonly requestId?: string
  readonly sessionID?: string
}
export type UiControlResult = { handled: boolean }

export type SkillPromptEvent = { readonly name: string; readonly text: string }
export type SessionCompactEvent = { readonly sessionID: string; readonly auto: boolean }
/** `{ skip: reason }` leaves the conversation as it is; the pending compaction is dropped and the loop stops. */
export type SessionCompactResult = { skip: string } | Record<string, unknown>
export type CommandDescribeEvent = {
  readonly name: string
  readonly description: string
  readonly argumentHint: string
  readonly isHidden: boolean
}
export type CommandDescribeResult = { description?: string; argumentHint?: string; isHidden?: boolean }

export interface ModEvents {
  "tool.call": { event: ToolCallEvent; result: ToolCallResult }
  "tool.check": { event: ToolCheckEvent; result: ToolCheckResult }
  "tool.describe": { event: ToolDescribeEvent; result: ToolDescribeResult }
  "prompt.submit": { event: PromptSubmitEvent; result: PromptSubmitResult }
  "session.start": { event: SessionStartEvent; result: Record<string, never> }
  "session.end": { event: SessionEndEvent; result: Record<string, never> }
  "skill.prompt": { event: SkillPromptEvent; result: { text: string } }
  "session.compact": { event: SessionCompactEvent; result: SessionCompactResult }
  "command.describe": { event: CommandDescribeEvent; result: CommandDescribeResult }
  "prompt.section": { event: PromptSectionEvent; result: PromptSectionResult }
  "prompt.compose": { event: PromptComposeEvent; result: PromptComposeResult }
  "command.run": { event: CommandRunEvent; result: CommandRunResult }
  "turn.start": { event: TurnStartEvent; result: Record<string, unknown> }
  "turn.step": { event: TurnStepEvent; result: TurnStepEvent }
  "turn.complete": { event: TurnCompleteEvent; result: Record<string, unknown> }
  "agent.offer": { event: AgentOfferEvent; result: AgentOfferResult }
  "agent.spawn": { event: AgentSpawnEvent; result: AgentSpawnResult }
  "ui.render": { event: UiRenderEvent; result: UiRenderResult }
  "ui.press": { event: UiControlEvent; result: UiControlResult }
  "ui.input": { event: UiControlEvent; result: UiControlResult }
  "ui.select": { event: UiControlEvent; result: UiControlResult }
  "plugin.register": { event: PluginRegisterEvent; result: PluginRegisterResult }
}

/** Every `$` method is also an event, named `namespace.method` (`fs.read`, `process.run`). */
export type ModApiEvent = `${"fs" | "process" | "http" | "env" | "store" | "ui" | "command"}.${string}`

/** A wildcard: `"*"` (everything but telemetry) or `"fs.*"` (a namespace). */
export type ModWildcard = "*" | `${string}.*`

export type ModHook<Name extends keyof ModEvents> = (
  $: ModApi,
  event: ModEvents[Name]["event"],
  next: ModNext<ModEvents[Name]["event"], ModEvents[Name]["result"]>,
) => ModEvents[Name]["result"] | Promise<ModEvents[Name]["result"]>

export interface ModRegistration {
  /** Set the hook's error handler: runs when the hook throws or times out (1 s limit). */
  catch(handler: ModHook<any>): ModRegistration
}

export interface ModOn {
  <Name extends keyof ModEvents>(event: Name, hook: ModHook<Name>): ModRegistration
  <Name extends keyof ModEvents>(
    event: Name,
    /** Fields compared with the event's: a value, an array of allowed values, or a RegExp. */
    matcher: { [Field in keyof ModEvents[Name]["event"]]?: unknown },
    hook: ModHook<Name>,
  ): ModRegistration
  /** The mods API calls (`fs.read`, ...) and wildcards (`"*"`, `"fs.*"`). Their events are not typed field by field. */
  (event: ModApiEvent | ModWildcard, hook: ($: ModApi, event: any, next: ModNext<any, any>) => unknown): ModRegistration
  (
    event: ModApiEvent | ModWildcard,
    matcher: Record<string, unknown>,
    hook: ($: ModApi, event: any, next: ModNext<any, any>) => unknown,
  ): ModRegistration
}

/** `register` receives `on` and the plugin's options from its `[spec, options]` entry in `nikcli.json`. */
export type ModRegister = (on: ModOn, options: Record<string, unknown>) => void

// -----------------------------------------------------------------------------
// The mods API: `$`

export interface ModApi {
  readonly plugin: { readonly name: string; readonly root?: string }
  readonly ui: {
    /** A dim line for the transcript. `{ to: "debug" }` writes the debug log only. */
    log(text: string, options?: { to?: "transcript" | "debug" }): Promise<void>
    toast(
      text: string,
      options?: { variant?: "info" | "success" | "warning" | "error"; timeoutMs?: number },
    ): Promise<void>
    notice(text: string): Promise<void>
    /** Ask the user. Resolves to the label picked or the text typed; rejects when dismissed or when there is no session. */
    ask(question: string, options: string[]): Promise<string>
    /** Put text on the system clipboard. */
    copy(text: string): Promise<void>
    /** The constructors for a drawing: `const { Box, Text, Button } = $.ui.resolve(e)`. */
    resolve(event?: unknown): ModElements
    /** Ask clients to draw again. Many calls close together become one. */
    invalidate(component?: "AbovePrompt" | "Pane", requestId?: string): void
    /**
     * Open a pane: `dock` in the sidebar, `inline` above the prompt. Draw it by answering `ui.render`
     * for `{ component: "Pane", requestId: id }`. Closed when the mod unloads.
     */
    open(input: { id: string; title?: string; placement?: "dock" | "inline"; rows?: number }): { close(): void }
    close(id: string): void
    panes(): { id: string; plugin: string; title: string; placement: "dock" | "inline"; rows?: number }[]
  }
  readonly command: {
    register(input: { name: string; description?: string; run: (args: string) => unknown }): { dispose(): void }
    run(name: string, args?: string): Promise<unknown>
    list(): { name: string; description?: string }[]
  }
  readonly tool: {
    /** Add a tool the model can call. `args` are zod fields, as for `tool()` from `@nikcli-ai/plugin/tool`. */
    register(input: {
      name: string
      description: string
      args: Record<string, any>
      execute: (args: any, context: any) => Promise<any>
    }): { dispose(): void }
    list(): string[]
  }
  readonly session: {
    /** The session the running hook belongs to. */
    id(): string | undefined
    cwd(): string
    root(): string
    /** The newest messages (4096 at most), oldest first. */
    messages(options?: {
      limit?: number
    }): Promise<{ id: string; role: string; agent?: string; text: string; tools: string[] }[]>
    /** `provider/model` the session last used. */
    model(): Promise<string | undefined>
    /** How many prompts the session has had. */
    turns(): Promise<number>
    repo(): Promise<{ root: string; vcs?: string; projectID: string }>
    version(): Promise<string>
    usage(): Promise<{
      startedAt?: number
      cost: number
      tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
    }>
  }
  readonly prompt: {
    /**
     * Start a turn from a hook or a timer. The model reads the text after a line naming this mod as the sender;
     * `asUser: true` sends it as the user's own words. It queues behind a turn already running and returns at once.
     */
    submit(input: { text: string; asUser?: boolean }): Promise<void>
    /** Add text to the user's prompt box as a draft. */
    fill(text: string): Promise<void>
  }
  readonly turn: {
    /** Stop the running turn of this session. */
    abort(): Promise<void>
  }
  readonly model: {
    /** One completion on the user's own model and plan. `maxTokens` defaults to 1024, 64000 at most. */
    complete(input: {
      prompt: string
      system?: string
      maxTokens?: number
      model?: string
      temperature?: number
    }): Promise<{ text: string; usage: { inputTokens?: number; outputTokens?: number } }>
    /** Pick one of `labels` for `text`; `undefined` when none fits. */
    classify(text: string, labels: string[], options?: { model?: string }): Promise<string | undefined>
  }
  readonly settings: {
    /** The resolved nikcli config. Values under keys that name a secret (key, token, password, ...) are redacted. */
    read(): Promise<Record<string, unknown>>
  }
  readonly mcp: {
    /** Call a tool of a connected MCP server. It asks permission like the model's own call does. */
    call(server: string, tool: string, args?: Record<string, unknown>): Promise<unknown>
    /** Connect an MCP server your nikcli config lists. */
    connect(server: string): Promise<void>
  }
  readonly agent: {
    list(): Promise<{ name: string; description?: string; mode?: string }[]>
  }
  /** Only nikcli and its built-in mods ever send a record: for an installed mod these do nothing. */
  readonly telemetry: { log(record?: unknown): void; mark(feature?: string): void }
  readonly env: { get(name: string): Promise<string | undefined>; set(name: string, value: string): Promise<void> }
  readonly fs: {
    read(path: string, options?: { encoding?: "utf8" | "base64" }): Promise<string>
    write(path: string, content: string | Uint8Array): Promise<void>
    list(path: string): Promise<{ name: string; kind: "file" | "directory" }[]>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<{ size: number; isDirectory: boolean; isFile: boolean; modifiedMs: number }>
    ancestors(path: string): Promise<string[]>
  }
  readonly process: {
    /** Run a command to completion. 30 s by default, 10 minutes at most. */
    run(
      command: string[],
      options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string },
    ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>
    spawn(
      command: string[],
      options?: { cwd?: string; env?: Record<string, string> },
    ): Promise<{ pid: number; kill(): void; exited: Promise<number> }>
  }
  readonly http: { fetch(url: string, init?: RequestInit): Promise<Response> }
  /** Key-value store shared by every session on the machine; 4 MiB of JSON in all. */
  readonly store: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
  }
  /** In-memory values that survive a reload of this mod. */
  readonly state: { get(key: string): unknown; set(key: string, value: unknown): void }
  readonly clock: {
    now(): number
    /** The one call that counts against the hook's own time. */
    sleep(ms: number): Promise<void>
    after(ms: number, fn: () => unknown): { cancel(): void }
    /** One run at a time: a tick that finds the previous run unfinished is skipped. Stopped when the mod unloads. */
    every(ms: number, fn: () => unknown): { cancel(): void }
  }
}
