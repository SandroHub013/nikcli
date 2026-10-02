import { TextAttributes } from "@opentui/core"
import { createSignal, For, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import type { ModNode } from "@nikcli-ai/plugin/mod"
import { useTheme } from "@tui/context/theme"

/**
 * Draws an element tree a mod answered a `ui.render` hook with.
 *
 * The tree is plain data from the server (`packages/nikcli/src/mod/ui.ts`), already checked against its
 * limits. Nothing in it runs here: a `Button` carries a `key`, and pressing it reports the key back.
 */
export type TreeEvents = {
  press: (key: string) => void
  input: (key: string, value: string, submit: boolean) => void
  select: (key: string, value: string) => void
}

type Element = Extract<ModNode, { type: string }>

/** How long typing settles before the mod hears about it. Enter reports at once. */
const INPUT_SETTLE_MS = 200

function useColors() {
  const { theme } = useTheme()
  return (name?: string) => {
    if (!name) return undefined
    switch (name) {
      case "default":
        return theme.foreground.default
      case "muted":
      case "dim":
      case "gray":
      case "grey":
        return theme.foreground.muted
      case "accent":
      case "primary":
        return theme.accent.fg
      case "success":
      case "green":
        return theme.status.success.fg
      case "warning":
      case "yellow":
        return theme.status.warning.fg
      case "error":
      case "red":
        return theme.status.error.fg
      case "info":
      case "blue":
        return theme.status.info.fg
      default:
        return name
    }
  }
}

function attributes(props: { bold?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean }) {
  let flags = 0
  if (props.bold) flags |= TextAttributes.BOLD
  if (props.italic) flags |= TextAttributes.ITALIC
  if (props.underline) flags |= TextAttributes.UNDERLINE
  if (props.inverse) flags |= TextAttributes.INVERSE
  return flags || undefined
}

const isElement = (node: ModNode): node is Element => typeof node === "object" && node !== null

/** The inline content of a `Text`: strings, numbers, and nested `Text` as styled spans. */
function Inline(props: { children: ModNode[] }): JSX.Element {
  const color = useColors()
  return (
    <For each={props.children}>
      {(child) => (
        <Switch>
          <Match when={typeof child === "string" || typeof child === "number"}>{String(child)}</Match>
          <Match when={isElement(child) && child.type === "Text" && child}>
            {(text) => {
              const el = text() as Extract<Element, { type: "Text" }>
              return (
                <span style={{ fg: color(el.props.color), bold: el.props.bold, italic: el.props.italic }}>
                  <Inline children={el.children} />
                </span>
              )
            }}
          </Match>
        </Switch>
      )}
    </For>
  )
}

function Field(props: { element: Extract<Element, { type: "Input" }>; events: TreeEvents }): JSX.Element {
  const { theme } = useTheme()
  const [focused, setFocused] = createSignal(props.element.props.autoFocus === true)
  let settle: ReturnType<typeof setTimeout> | undefined
  // What has been typed so far: Enter reports it, because the submit event carries no value.
  let typed = props.element.props.value ?? ""
  onCleanup(() => settle && clearTimeout(settle))
  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <Show when={props.element.props.label}>
        <text fg={theme.foreground.muted}>{props.element.props.label}</text>
      </Show>
      <box flexGrow={1} border={["bottom"]} borderColor={focused() ? theme.accent.fg : theme.border.subtle}>
        <input
          value={props.element.props.value ?? ""}
          placeholder={props.element.props.placeholder}
          focused={focused()}
          cursorColor={theme.accent.fg}
          focusedTextColor={theme.foreground.default}
          onMouseDown={() => setFocused(true)}
          onInput={(value: string) => {
            typed = value
            if (settle) clearTimeout(settle)
            settle = setTimeout(() => props.events.input(props.element.key, typed, false), INPUT_SETTLE_MS)
          }}
          onSubmit={() => {
            if (settle) clearTimeout(settle)
            props.events.input(props.element.key, typed, true)
          }}
        />
      </box>
      <Show when={props.element.props.submitLabel}>
        <text fg={theme.accent.fg}>{props.element.props.submitLabel}</text>
      </Show>
    </box>
  )
}

export function Tree(props: { node: ModNode; events: TreeEvents }): JSX.Element {
  const { theme, syntax } = useTheme()
  const color = useColors()

  return (
    <Switch>
      <Match when={typeof props.node === "string" || typeof props.node === "number"}>
        <text fg={theme.foreground.default}>{String(props.node)}</text>
      </Match>
      {/* keyed: a new tree from the mod rebuilds this subtree; the element is read once per tree. */}
      <Match keyed when={isElement(props.node) && props.node}>
        {(node) => {
          const el = node as Element
          return (
            <Switch>
              <Match when={el.type === "Box"}>
                {(() => {
                  const box = el as Extract<Element, { type: "Box" }>
                  const border = box.props.borderStyle
                  return (
                    <box
                      flexDirection={box.props.direction ?? "column"}
                      gap={box.props.gap}
                      padding={box.props.padding}
                      margin={box.props.margin}
                      width={box.props.width as number | undefined}
                      height={box.props.height}
                      justifyContent={box.props.justifyContent}
                      alignItems={box.props.alignItems}
                      backgroundColor={color(box.props.backgroundColor)}
                      border={border ? true : undefined}
                      borderStyle={border === "round" ? "rounded" : border === "bold" ? "heavy" : border}
                      borderColor={theme.border.default}
                    >
                      <For each={box.children}>{(child) => <Tree node={child} events={props.events} />}</For>
                    </box>
                  )
                })()}
              </Match>
              <Match when={el.type === "Text"}>
                {(() => {
                  const text = el as Extract<Element, { type: "Text" }>
                  return (
                    <text
                      fg={
                        color(text.props.color) ??
                        (text.props.dimColor ? theme.foreground.muted : theme.foreground.default)
                      }
                      bg={color(text.props.backgroundColor)}
                      attributes={attributes(text.props)}
                      wrapMode={text.props.wrap === "none" ? "none" : "word"}
                    >
                      <Inline children={text.children} />
                    </text>
                  )
                })()}
              </Match>
              <Match when={el.type === "Button"}>
                {(() => {
                  const button = el as Extract<Element, { type: "Button" }>
                  return (
                    <box
                      flexDirection="row"
                      paddingLeft={button.props.plain ? 0 : 1}
                      paddingRight={button.props.plain ? 0 : 1}
                      backgroundColor={button.props.plain ? undefined : theme.surface.offset}
                      onMouseDown={() => props.events.press(button.key)}
                    >
                      <text fg={button.props.dimColor ? theme.foreground.muted : theme.accent.fg}>
                        {button.props.label}
                      </text>
                    </box>
                  )
                })()}
              </Match>
              <Match when={el.type === "Link"}>
                {(() => {
                  const link = el as Extract<Element, { type: "Link" }>
                  return (
                    <text fg={theme.accent.fg} attributes={TextAttributes.UNDERLINE}>
                      {link.props.label ?? link.props.href}
                    </text>
                  )
                })()}
              </Match>
              <Match when={el.type === "Code"}>
                <text fg={theme.foreground.muted} wrapMode="none">
                  {(el as Extract<Element, { type: "Code" }>).props.text}
                </text>
              </Match>
              <Match when={el.type === "Markdown"}>
                <markdown
                  syntaxStyle={syntax()}
                  content={(el as Extract<Element, { type: "Markdown" }>).props.text}
                  fg={
                    (el as Extract<Element, { type: "Markdown" }>).props.dimColor
                      ? theme.foreground.muted
                      : theme.foreground.default
                  }
                />
              </Match>
              <Match when={el.type === "Input"}>
                <Field element={el as Extract<Element, { type: "Input" }>} events={props.events} />
              </Match>
              <Match when={el.type === "Select"}>
                {(() => {
                  const select = el as Extract<Element, { type: "Select" }>
                  return (
                    <box>
                      <Show when={select.props.label}>
                        <text fg={theme.foreground.muted}>{select.props.label}</text>
                      </Show>
                      <For each={select.props.options}>
                        {(option) => (
                          <box
                            flexDirection="row"
                            gap={1}
                            onMouseDown={() => props.events.select(select.key, option.value)}
                          >
                            <text fg={select.props.value === option.value ? theme.accent.fg : theme.foreground.muted}>
                              {select.props.value === option.value ? "●" : "○"}
                            </text>
                            <text fg={theme.foreground.default}>{option.label ?? option.value}</text>
                          </box>
                        )}
                      </For>
                    </box>
                  )
                })()}
              </Match>
            </Switch>
          )
        }}
      </Match>
    </Switch>
  )
}
