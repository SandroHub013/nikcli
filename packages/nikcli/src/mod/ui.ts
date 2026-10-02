/**
 * What a mod draws: element trees as plain data.
 *
 * Mods run in the server process and the terminal (or any other client) draws
 * for them, so a tree has to cross the wire. That is why a `Button` carries a
 * `key` instead of a callback: pressing it sends `ui.press { key }` back to the
 * mods, which answer with a hook. Nothing in a tree is executable.
 *
 * Trees are validated before they leave the server. A mod is not trusted to
 * send a tree a client can render in bounded time.
 */
export namespace ModUi {
  export const MAX_DEPTH = 16
  export const MAX_NODES = 2_000
  export const MAX_TEXT = 10_000

  export type Node = Element | string | number | false | null | undefined

  export type Element =
    | { type: "Box"; key?: string; props: BoxProps; children: Node[] }
    | { type: "Text"; key?: string; props: TextProps; children: Node[] }
    | { type: "Button"; key: string; props: ButtonProps }
    | { type: "Link"; props: { href: string; label?: string } }
    | { type: "Code"; props: { text: string; language?: string } }
    | { type: "Markdown"; key?: string; props: { text: string; dimColor?: boolean } }
    | { type: "Input"; key: string; props: InputProps }
    | { type: "Select"; key: string; props: SelectProps }

  export type BoxProps = {
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

  export type TextProps = {
    color?: string
    backgroundColor?: string
    bold?: boolean
    italic?: boolean
    underline?: boolean
    dimColor?: boolean
    inverse?: boolean
    wrap?: "wrap" | "none"
  }

  export type ButtonProps = { label: string; hotkey?: string; plain?: boolean; dimColor?: boolean; autoFocus?: boolean }
  export type InputProps = {
    label?: string
    placeholder?: string
    value?: string
    submitLabel?: string
    autoFocus?: boolean
  }
  export type SelectProps = { label?: string; options: { value: string; label?: string }[]; value?: string }

  /** Where a mod can draw. `props` are what nikcli passes the `ui.render` hook. */
  export type Site =
    | "AbovePrompt"
    | "Pane"
    // Sites nikcli draws itself: a mod's tree replaces them, and with none that draws, nothing changes.
    | "ToolUse"
    | "UserMessage"
    | "AssistantMessage"
    | "Spinner"
  export const SITES: readonly Site[] = ["AbovePrompt", "Pane", "ToolUse", "UserMessage", "AssistantMessage", "Spinner"]

  export type Placement = "dock" | "inline"

  export interface PaneInfo {
    id: string
    plugin: string
    title: string
    placement: Placement
    /** Rows an inline pane may take; beyond them it scrolls. */
    rows?: number
  }

  const isElement = (value: unknown): value is Element =>
    typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"

  /** A leaf's `props` argument is a plain object that is not itself an element. */
  const isProps = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) && !isElement(value)

  /**
   * The constructors `$.ui.resolve(e)` returns. `Box(props, ...children)`, `Text("hi")` or
   * `Text({ bold: true }, "hi")`, `Button({ key, label })`, and so on. They only build data.
   */
  export function builders() {
    const container =
      (type: "Box" | "Text") =>
      (first?: unknown, ...rest: Node[]): Element => {
        const props = isProps(first) ? first : {}
        const children = (isProps(first) ? rest : [first as Node, ...rest]).flat() as Node[]
        const { key, ...own } = props as { key?: string }
        return { type, ...(key === undefined ? {} : { key }), props: own, children } as Element
      }
    const leaf =
      (type: Exclude<Element["type"], "Box" | "Text">) =>
      (props: Record<string, unknown> = {}): Element => {
        const { key, ...own } = props as { key?: string }
        return { type, ...(key === undefined ? {} : { key }), props: own } as Element
      }
    return {
      Box: container("Box"),
      Text: container("Text"),
      Button: leaf("Button"),
      Link: leaf("Link"),
      Code: leaf("Code"),
      Markdown: leaf("Markdown"),
      Input: leaf("Input"),
      Select: leaf("Select"),
    }
  }

  const THEME_COLORS = /^(#[0-9a-fA-F]{3,8}|[a-z]+)$/

  /**
   * Check a tree against the limits and the shape a client can draw. Returns the first problem, or
   * `undefined` when the tree is fine.
   */
  export function validate(tree: unknown): string | undefined {
    let nodes = 0
    const walk = (node: unknown, depth: number): string | undefined => {
      if (node === null || node === undefined || node === false) return undefined
      if (typeof node === "string")
        return node.length > MAX_TEXT ? `a string is longer than ${MAX_TEXT} characters` : undefined
      if (typeof node === "number") return undefined
      if (!isElement(node)) return `a node is not an element, a string or a number`
      if (++nodes > MAX_NODES) return `the tree has more than ${MAX_NODES} nodes`
      if (depth > MAX_DEPTH) return `the tree is deeper than ${MAX_DEPTH} levels`
      const props = (node as { props?: Record<string, unknown> }).props ?? {}
      for (const color of [props.color, props.backgroundColor]) {
        if (color !== undefined && (typeof color !== "string" || !THEME_COLORS.test(color))) {
          return `${node.type} has a color that is not a name or a #hex value`
        }
      }
      switch (node.type) {
        case "Box":
        case "Text": {
          for (const child of node.children ?? []) {
            const bad = walk(child, depth + 1)
            if (bad) return bad
          }
          return undefined
        }
        case "Button":
          if (typeof node.key !== "string" || !node.key) return "a Button needs a key"
          return typeof node.props.label === "string" ? undefined : "a Button needs a label"
        case "Input":
        case "Select":
          if (typeof node.key !== "string" || !node.key) return `${node.type} needs a key`
          if (node.type === "Select" && !Array.isArray(node.props.options)) return "a Select needs options"
          return undefined
        case "Link":
          return typeof node.props.href === "string" ? undefined : "a Link needs an href"
        case "Code":
        case "Markdown":
          if (typeof node.props.text !== "string") return `${node.type} needs text`
          return node.props.text.length > MAX_TEXT
            ? `${node.type} text is longer than ${MAX_TEXT} characters`
            : undefined
        default:
          return `unknown element ${(node as { type: string }).type}`
      }
    }
    return walk(tree, 0)
  }

  /** What a `ui.render` hook may answer: draw this tree, draw nothing, or (for a rewriting hook) the event itself. */
  export type RenderResult = { tree: Node } | { props: Record<string, unknown> } | Record<string, unknown>

  /** The tree a render result asks for, `null` for "nothing", or `undefined` when it is not a drawing at all. */
  export function treeOf(result: unknown): Node | undefined {
    if (typeof result !== "object" || result === null) return undefined
    return "tree" in result ? ((result as { tree: Node }).tree ?? null) : undefined
  }
}
