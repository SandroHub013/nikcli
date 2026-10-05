import type {
  Agent,
  Command,
  ConnectorStatus,
  Event,
  McpResource,
  McpStatus,
  Message,
  Model,
  NikcliClient,
  Part,
  PermissionRequest,
  PermissionRule,
  Provider,
  Pty,
  QuestionRequest,
  ReferenceConfig,
  Session,
  SessionEntry,
} from "@nikcli-ai/sdk/httpapi"
import type { JSX } from "@opentui/solid"
import type { Store } from "solid-js/store"
import type { TuiDialogAlertProps, TuiKV, TuiToast } from "../../tui"

export type LocationRef = {
  readonly directory: string
  readonly workspaceID?: string
}

export type SessionInfo = Session
/** A live v2 entry — flat, discriminated on `type` (see session/v2/entry.ts). */
export type SessionPendingInfo = SessionEntry
/** A persisted v2 entry: the whole conversation, flat. */
export type SessionEntryInfo = SessionEntry
export type SessionMessageInfo = {
  readonly info: Message
  readonly parts: Part[]
}
export type PermissionV2Request = PermissionRequest
export type FormInfo = QuestionRequest
export type PermissionSavedInfo = PermissionRule
export type ShellInfo = Pty
export type AgentInfo = Agent
export type CommandInfo = Command
export type IntegrationInfo = {
  readonly name: string
  readonly status: ConnectorStatus
}
export type McpServer = { readonly name: string; readonly status: McpStatus }
export type ModelInfo = Model
export type ProviderV2Info = Provider
export type ReferenceInfo = ReferenceConfig & { readonly name: string }
export type SkillInfo = {
  readonly name: string
  readonly description: string
  readonly location: string
  readonly category?: string
  readonly tags?: string[]
  readonly version?: string
}

interface LocationCollection<Value> {
  list(location?: LocationRef): Value[] | undefined
  refresh(location?: LocationRef): Promise<void>
}

/** Reactive nikcli data exposed to a v2 TUI plugin. */
export interface Data {
  readonly on: <Type extends Event["type"]>(
    type: Type,
    handler: (event: Extract<Event, { type: Type }>) => void,
  ) => () => void
  readonly listen: (handler: (event: { details: Event }) => void) => () => void
  readonly session: {
    list(): SessionInfo[]
    get(sessionID: string): SessionInfo | undefined
    root(sessionID: string): string
    family(sessionID: string): string[]
    cost(sessionID: string): number
    status(sessionID: string): "idle" | "running"
    readonly pending: {
      list(sessionID: string): SessionPendingInfo[]
      refresh(sessionID: string): Promise<void>
    }
    refresh(sessionID: string): Promise<void>
    readonly message: {
      list(sessionID: string): SessionMessageInfo[]
      get(sessionID: string, messageID: string): SessionMessageInfo | undefined
      refresh(sessionID: string): Promise<void>
    }
    /**
     * The conversation as flat v2 entries — user, start, text, reasoning,
     * tool, subtask, complete, retry, compaction. Backed by the persisted
     * projection, so it covers committed and in-flight work alike; `pending`
     * is the sub-flush-interval streaming tail on top of it.
     */
    readonly entry: {
      list(sessionID: string): SessionEntryInfo[]
      refresh(sessionID: string): Promise<void>
    }
    readonly permission: {
      list(sessionID: string): PermissionV2Request[] | undefined
      refresh(sessionID: string): Promise<void>
    }
    readonly form: {
      list(sessionID: string, location?: LocationRef): Array<FormInfo & { readonly location?: LocationRef }> | undefined
      refresh(sessionID: string, location?: LocationRef): Promise<void>
    }
  }
  readonly project: {
    readonly permission: {
      list(projectID: string): PermissionSavedInfo[] | undefined
      refresh(projectID: string): Promise<void>
    }
  }
  readonly shell: {
    list(location?: LocationRef): ShellInfo[]
    get(id: string): ShellInfo | undefined
    refresh(location?: LocationRef): Promise<void>
  }
  readonly location: {
    default(): LocationRef
    refresh(location?: LocationRef): Promise<void>
    readonly agent: LocationCollection<AgentInfo>
    readonly command: LocationCollection<CommandInfo>
    readonly integration: LocationCollection<IntegrationInfo>
    readonly mcp: {
      readonly server: LocationCollection<McpServer>
      readonly resource: LocationCollection<McpResource>
    }
    readonly model: LocationCollection<ModelInfo>
    readonly provider: LocationCollection<ProviderV2Info>
    readonly reference: LocationCollection<ReferenceInfo>
    readonly skill: LocationCollection<SkillInfo>
  }
}

export type Route =
  | { readonly type: "home" }
  | { readonly type: "session"; readonly sessionID: string }
  | {
      readonly type: "plugin"
      readonly id: string
      readonly name: string
      readonly data?: Record<string, unknown>
    }

export type Destination = Route | Omit<Extract<Route, { readonly type: "plugin" }>, "id">

export interface Page {
  readonly name: string
  readonly render: (input: { readonly data?: Record<string, unknown> }) => JSX.Element
}

export type Slot = (props: Record<string, unknown>) => JSX.Element

/**
 * A presentation field that may be derived at read time.
 *
 * The palette re-reads a registered command on every open — `createMemo` in the
 * command dialog wraps the registration callback — but only if the callback
 * actually reads something reactive. A plain value is captured once, at
 * registration, so a command whose title or enabled state depends on settings
 * would show a snapshot from whenever the plugin was loaded. v1 plugins escape
 * this because `keymap.registerLayer` accepts a thunk; v2 passed an array
 * literal, so the reactive seam downstream was never reached.
 *
 * Only presentation fields accept this. `name` stays static on purpose: it is
 * the dedupe key and the dispatch key, and a command whose identity changes
 * between reads is two commands wearing one name.
 */
export type UICommandValue<Value> = Value | (() => Value)

/**
 * A command a plugin adds to the command palette and, optionally, to the `/`
 * slash menu. Mirrors what a v1 plugin registers with `keymap.registerLayer`, so
 * migrating a plugin to v2 does not change which commands the user sees.
 */
export interface UICommand {
  /** Unique command id, e.g. `browser.sessions`. */
  readonly name: string
  readonly title: UICommandValue<string>
  readonly description?: UICommandValue<string | undefined>
  /** Command palette category. */
  readonly namespace?: UICommandValue<string | undefined>
  /** Registers the command as `/<slash.name>`. */
  readonly slash?: {
    readonly name: string
    readonly aliases?: readonly string[]
    /** `/name <text>` runs the command with `<text>` as `input` instead of selecting it. */
    readonly arguments?: boolean
  }
  readonly suggested?: UICommandValue<boolean | undefined>
  readonly hidden?: UICommandValue<boolean | undefined>
  readonly enabled?: UICommandValue<boolean | undefined>
  readonly run: (input?: string) => void
}

export interface UI {
  readonly router: {
    register(page: Page): () => void
    navigate(destination: Destination): void
    current(): Route
  }
  readonly slot: (name: string, render: Slot) => () => void
  /** Adds a command. Needs the `commands` capability when the plugin has a manifest. Returns unregister. */
  readonly command: (command: UICommand) => () => void
  /**
   * The host dialog stack, the part a command needs to show something. Not gated:
   * a dialog is only reachable from a command or page the plugin already declared.
   */
  readonly dialog: {
    replace(render: () => JSX.Element, onClose?: () => void): void
    clear(): void
  }
  /**
   * A modal confirmation, and a transient notification.
   *
   * Both were missing here and both cost a real plugin its only way to ask the
   * user anything: `computer` had no way to say "this needs you" without taking
   * over the dialog stack. They are v1's own prop types, aliased rather than
   * restated — the host already implements both (`plugin/api.tsx`), so a
   * lookalike would be a second contract with nothing enforcing that the two
   * agree.
   */
  readonly DialogAlert: (props: TuiDialogAlertProps) => JSX.Element
  readonly toast: (input: TuiToast) => void
}

/**
 * The v2 name for the TUI's shared key-value store.
 *
 * This is v1's `TuiKV` itself, not a copy of it, and that is the whole point.
 * Both names resolve to the *same* `state/kv.json` instance that `useKV()` hands
 * the component tree, so a plugin that moves from `api.kv` to `kv` reads and
 * writes the bytes the user's existing install already wrote. A lookalike type
 * would typecheck the same and then let the two drift — the plugin would appear
 * to work while a dialog row and the `/` command were reading different stores.
 *
 * `storage.store` is the per-plugin alternative
 * (`state/tui/plugin/<id>.<key>.json`). Prefer it for a plugin's own state; reach
 * for `kv` only when migrating state that predates the v2 plugin API and is
 * therefore already in `kv.json`.
 */
export type KV = TuiKV

export interface Storage {
  /**
   * Durable JSON state: persisted to disk, survives hot reloads and TUI
   * restarts, and stays in sync across running TUI instances.
   */
  store<Value extends object>(
    key: string,
    options: {
      readonly initial: Value
    },
  ): readonly [Store<Value>, (mutation: (draft: Value) => void) => Promise<void>]
  /**
   * Ephemeral in-memory state: survives plugin hot reloads (the old and the new
   * generation share the same live store) and is gone when the TUI exits.
   * Updates are synchronous and values need not be JSON-serializable.
   */
  memory<Value extends object>(
    key: string,
    options: {
      readonly initial: Value
    },
  ): readonly [Store<Value>, (mutation: (draft: Value) => void) => void]
}

export interface Context {
  readonly options: Readonly<Record<string, unknown>>
  readonly client: NikcliClient
  readonly data: Data
  readonly storage: Storage
  readonly kv: KV
  readonly ui: UI
}
