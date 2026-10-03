/**
 * What a mod draws and how a client talks to the mods, with no renderer in it.
 *
 * Mods run in the nikcli server and answer `POST /mod/ui/render` with an element tree: plain data,
 * already checked against the server's limits (`packages/nikcli/src/mod/ui.ts`). The types are the
 * structural twin of `@nikcli-ai/plugin/mod`'s `ModNode`, restated because this package does not
 * depend on the plugin package. This file is plain TypeScript so it can be tested without a DOM.
 */

export type ModSurface = "terminal" | "mobile" | "desktop" | "ade"

export type ModBoxProps = {
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

export type ModTextProps = {
  color?: string
  backgroundColor?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dimColor?: boolean
  inverse?: boolean
  wrap?: "wrap" | "none"
}

export type ModElement =
  | { type: "Box"; key?: string; props: ModBoxProps; children: ModNode[] }
  | { type: "Text"; key?: string; props: ModTextProps; children: ModNode[] }
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

export type ModNode = ModElement | string | number | false | null | undefined

export type ModPane = {
  id: string
  plugin: string
  title: string
  placement: "dock" | "inline"
  rows?: number
}

export type ModInfo = {
  id: string
  name: string
  tier: "prepend" | "user" | "append" | "builtin"
  rank: number
  events: string[]
  tools: string[]
  commands: string[]
}

export type ModEvents = {
  press: (key: string) => void
  input: (key: string, value: string, submit: boolean) => void
  select: (key: string, value: string) => void
}

/** The wire answer of `POST /mod/ui/render`. */
export type ModRenderOutput = { kind: "default" | "tree"; tree?: string; props?: string }

/** The drawing a mod answered with (`tree: null` is "draw nothing"), or `undefined` for no drawing at all. */
export type ModAnswer = { tree: ModNode } | undefined

export type ModHostEvent = { type: string; properties?: Record<string, unknown> }

/**
 * Where a client reaches the mods. Desktop builds it from the SDK client and the global event stream;
 * ADE builds it from the client of the project it is open on. The renderer asks it everything, so it
 * knows nothing about either.
 */
export interface ModSource {
  readonly surface: ModSurface
  list(): Promise<ModInfo[] | undefined>
  panes(): Promise<ModPane[] | undefined>
  render(input: {
    component: string
    requestId: string
    sessionID?: string
    props?: Record<string, unknown>
  }): Promise<ModRenderOutput | undefined>
  event(input: {
    kind: "press" | "input" | "select"
    key: string
    value?: string
    submit?: boolean
    component?: string
    requestId?: string
    sessionID?: string
  }): Promise<unknown>
  /** Every `mod.ui.*` event the client hears, until the returned function is called. */
  subscribe(listener: (event: ModHostEvent) => void): () => void
}

/** How long typing settles before the mod hears about it. Enter reports at once. */
export const MOD_INPUT_SETTLE_MS = 200

export const isModElement = (node: ModNode): node is ModElement => typeof node === "object" && node !== null

/**
 * The tree in a render answer. `kind: "default"` means no mod drew anything, and an unparsable tree is
 * treated the same way: a window that cannot draw a mod's answer shows nothing rather than failing.
 */
export function modAnswerFrom(output: ModRenderOutput | undefined): ModAnswer {
  if (!output || output.kind !== "tree") return undefined
  if (output.tree === undefined) return { tree: null }
  try {
    return { tree: JSON.parse(output.tree) as ModNode }
  } catch {
    return undefined
  }
}

/** Whether an invalidation reaches one render site. An untargeted one reaches them all. */
export function modInvalidates(event: ModHostEvent, site: { component: string; requestId: string }) {
  if (event.type !== "mod.ui.invalidate") return false
  const component = event.properties?.component
  const requestID = event.properties?.requestID
  if (typeof component === "string" && component && component !== site.component) return false
  if (typeof requestID === "string" && requestID && requestID !== site.requestId) return false
  return true
}

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"])

/** A mod's link is a link only when it is a web or mail address; anything else is inert text. */
export function modSafeHref(href: string): string | undefined {
  try {
    const url = new URL(href)
    return SAFE_SCHEMES.has(url.protocol) ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * A color a mod named: a semantic word the terminal also knows, or a `#hex`. The server only lets those
 * shapes through, so anything else is dropped.
 */
export function modColor(name: string | undefined): string | undefined {
  if (!name) return undefined
  switch (name) {
    case "default":
      return "var(--mod-text, var(--text-base))"
    case "muted":
    case "dim":
    case "gray":
    case "grey":
      return "var(--mod-text-weak, var(--text-weak))"
    case "accent":
    case "primary":
    case "info":
    case "blue":
      return "var(--mod-accent, var(--text-interactive-base))"
    case "success":
    case "green":
      return "var(--mod-success, var(--text-success-base))"
    case "warning":
    case "yellow":
      return "var(--mod-warning, var(--text-warning-base))"
    case "error":
    case "red":
      return "var(--mod-critical, var(--text-critical-base))"
    default:
      return /^#[0-9a-fA-F]{3,8}$/.test(name) ? name : undefined
  }
}
