/**
 * What a mod draws, as the phone reads it.
 *
 * Mods run in the nikcli server and answer `POST /mod/ui/render` with an element tree: plain data,
 * already checked against the server's limits (`packages/nikcli/src/mod/ui.ts`). The same mod draws
 * for the terminal, the desktop and this app; it tells them apart by the `surface` the client sends.
 * These types are the structural twin of `@nikcli-ai/plugin/mod`'s `ModNode`, restated because the
 * app bundles with Metro and does not depend on the plugin package. Nothing in a tree runs here:
 * a `Button` carries a `key` and pressing it reports the key back.
 */
import type { ThemeColors } from "@/lib/theme"

export const MOD_SURFACE = "mobile" as const

/** How long typing settles before the mod hears about it. Submitting reports at once. */
export const MOD_INPUT_SETTLE_MS = 200

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

/** One loaded mod, as `GET /mod` lists it. */
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

export const isModElement = (node: ModNode): node is ModElement => typeof node === "object" && node !== null

/**
 * The tree in a render answer. `kind: "default"` means no mod drew anything, and an unparsable tree
 * is treated the same way: a phone that cannot draw a mod's answer shows nothing rather than failing.
 */
export function answerFrom(output: ModRenderOutput | undefined): ModAnswer {
  if (!output || output.kind !== "tree") return undefined
  if (output.tree === undefined) return { tree: null }
  try {
    return { tree: JSON.parse(output.tree) as ModNode }
  } catch {
    return undefined
  }
}

/** Whether a host event means the set of panes, or what one draws, may have changed. */
export function isModEvent(event: { type: string }) {
  return event.type === "mod.ui.panes" || event.type === "mod.ui.invalidate"
}

/** Whether an invalidation reaches one render site. An untargeted one reaches them all. */
export function invalidates(
  event: { type: string; properties?: Record<string, unknown> },
  site: { component: string; requestId: string },
) {
  if (event.type !== "mod.ui.invalidate") return false
  const component = event.properties?.component
  const requestID = event.properties?.requestID
  if (typeof component === "string" && component && component !== site.component) return false
  if (typeof requestID === "string" && requestID && requestID !== site.requestId) return false
  return true
}

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"])

/** A mod's link is opened only when it is a web or mail address; anything else is inert. */
export function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href)
    return SAFE_SCHEMES.has(url.protocol) ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * A color a mod named: a semantic word the terminal also knows (`muted`, `success`, `red`...), or a
 * `#hex`. The server only lets those shapes through, so anything else is dropped.
 */
export function modColor(
  name: string | undefined,
  palette: Pick<ThemeColors, "ink" | "muted" | "accent" | "success" | "warn" | "danger" | "info">,
): string | undefined {
  if (!name) return undefined
  switch (name) {
    case "default":
      return palette.ink
    case "muted":
    case "dim":
    case "gray":
    case "grey":
      return palette.muted
    case "accent":
    case "primary":
      return palette.accent
    case "success":
    case "green":
      return palette.success
    case "warning":
    case "yellow":
      return palette.warn
    case "error":
    case "red":
      return palette.danger
    case "info":
    case "blue":
      return palette.info
    default:
      return /^#[0-9a-fA-F]{3,8}$/.test(name) ? name : undefined
  }
}

/** The plain text of a node, for a screen reader label. */
export function plainText(node: ModNode): string {
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (!isModElement(node)) return ""
  switch (node.type) {
    case "Box":
      return node.children.map(plainText).filter(Boolean).join(" ")
    case "Text":
      return node.children.map(plainText).join("")
    case "Button":
      return node.props.label
    case "Link":
      return node.props.label ?? node.props.href
    case "Code":
    case "Markdown":
      return node.props.text
    case "Input":
      return node.props.label ?? node.props.placeholder ?? ""
    case "Select":
      return node.props.label ?? ""
  }
}
