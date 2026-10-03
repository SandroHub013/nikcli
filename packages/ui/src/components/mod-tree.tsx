import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js"
import {
  isModElement,
  MOD_INPUT_SETTLE_MS,
  modAnswerFrom,
  modColor,
  modInvalidates,
  modSafeHref,
  type ModAnswer,
  type ModBoxProps,
  type ModElement,
  type ModEvents,
  type ModNode,
  type ModSource,
  type ModTextProps,
} from "./mod-tree-model"

export * from "./mod-tree-model"

/**
 * Draws what a mod answered with, as DOM.
 *
 * Mods run in the nikcli server and answer `POST /mod/ui/render` with an element tree: plain data,
 * already checked against the server's limits (`packages/nikcli/src/mod/ui.ts`). The terminal draws
 * it with cells, the phone with native views, and the desktop and ADE with this. The same mod serves
 * all of them and tells them apart by the `surface` each one sends, so it can answer with a layout
 * made for the window it is drawing in. Nothing in a tree runs here: a `Button` carries a `key` and
 * pressing it reports the key back through `ModSource.event`.
 */

const GAP_UNIT = 4

function boxStyle(props: ModBoxProps): JSX.CSSProperties {
  return {
    "flex-direction": props.direction ?? "column",
    gap: props.gap === undefined ? undefined : `${props.gap * GAP_UNIT}px`,
    padding: props.padding === undefined ? undefined : `${props.padding * GAP_UNIT * 2}px`,
    margin: props.margin === undefined ? undefined : `${props.margin * GAP_UNIT}px`,
    // A number is a count of terminal cells, which means nothing here; only a percentage is a size.
    width: typeof props.width === "string" && /^\d+(\.\d+)?%$/.test(props.width) ? props.width : undefined,
    height: props.height === undefined ? undefined : `${props.height * GAP_UNIT * 4}px`,
    "justify-content": props.justifyContent,
    "align-items": props.alignItems,
    "background-color": modColor(props.backgroundColor),
  }
}

function textStyle(props: ModTextProps): JSX.CSSProperties {
  return {
    color: modColor(props.color),
    "background-color": modColor(props.backgroundColor),
    "font-weight": props.bold ? 700 : undefined,
    "font-style": props.italic ? "italic" : undefined,
    "text-decoration": props.underline ? "underline" : undefined,
    "white-space": props.wrap === "none" ? "pre" : "pre-wrap",
  }
}

/** The inline content of a `Text`: strings, numbers, and nested `Text` as styled spans. */
function Inline(props: { children: ModNode[] }): JSX.Element {
  return (
    <For each={props.children}>
      {(child) => (
        <Switch>
          <Match when={typeof child === "string" || typeof child === "number"}>{String(child)}</Match>
          <Match when={isModElement(child) && child.type === "Text" && child}>
            {(text) => {
              const el = text() as Extract<ModElement, { type: "Text" }>
              return (
                <span data-slot="text" data-dim={el.props.dimColor ? "" : undefined} style={textStyle(el.props)}>
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

function Field(props: { element: Extract<ModElement, { type: "Input" }>; events: ModEvents }): JSX.Element {
  const [value, setValue] = createSignal(props.element.props.value ?? "")
  let settle: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => settle && clearTimeout(settle))
  // A new tree carries the mod's own value for this field; typing in between is the user's.
  createEffect(
    on(
      () => props.element.props.value,
      (next) => setValue(next ?? ""),
      { defer: true },
    ),
  )

  const submit = () => {
    if (settle) clearTimeout(settle)
    props.events.input(props.element.key, value(), true)
  }

  return (
    <label data-slot="field">
      <Show when={props.element.props.label}>
        <span data-slot="label">{props.element.props.label}</span>
      </Show>
      <span data-slot="control">
        <input
          type="text"
          value={value()}
          placeholder={props.element.props.placeholder}
          autofocus={props.element.props.autoFocus}
          aria-label={props.element.props.label ?? props.element.props.placeholder}
          onInput={(event) => {
            const next = event.currentTarget.value
            setValue(next)
            if (settle) clearTimeout(settle)
            settle = setTimeout(() => props.events.input(props.element.key, next, false), MOD_INPUT_SETTLE_MS)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit()
          }}
        />
        <Show when={props.element.props.submitLabel}>
          <button type="button" data-slot="submit" onClick={submit}>
            {props.element.props.submitLabel}
          </button>
        </Show>
      </span>
    </label>
  )
}

export function ModTree(props: {
  node: ModNode
  events: ModEvents
  /** Draws a `Markdown` element. Without one its text is shown as it is written. */
  markdown?: (text: string) => JSX.Element
}): JSX.Element {
  return (
    <Switch>
      <Match when={typeof props.node === "string" || typeof props.node === "number"}>
        <span data-slot="text">{String(props.node)}</span>
      </Match>
      {/* keyed: a new tree from the mod rebuilds this subtree; the element is read once per tree. */}
      <Match keyed when={isModElement(props.node) && props.node}>
        {(node) => {
          const el = node as ModElement
          return (
            <Switch>
              <Match when={el.type === "Box"}>
                {(() => {
                  const box = el as Extract<ModElement, { type: "Box" }>
                  return (
                    <div data-slot="box" data-border={box.props.borderStyle} style={boxStyle(box.props)}>
                      <For each={box.children}>
                        {(child) => <ModTree node={child} events={props.events} markdown={props.markdown} />}
                      </For>
                    </div>
                  )
                })()}
              </Match>
              <Match when={el.type === "Text"}>
                {(() => {
                  const text = el as Extract<ModElement, { type: "Text" }>
                  return (
                    <p
                      data-slot="text"
                      data-dim={text.props.dimColor ? "" : undefined}
                      data-inverse={text.props.inverse ? "" : undefined}
                      style={textStyle(text.props)}
                    >
                      <Inline children={text.children} />
                    </p>
                  )
                })()}
              </Match>
              <Match when={el.type === "Button"}>
                {(() => {
                  const button = el as Extract<ModElement, { type: "Button" }>
                  return (
                    <button
                      type="button"
                      data-slot="button"
                      data-plain={button.props.plain ? "" : undefined}
                      data-dim={button.props.dimColor ? "" : undefined}
                      autofocus={button.props.autoFocus}
                      onClick={() => props.events.press(button.key)}
                    >
                      {button.props.label}
                    </button>
                  )
                })()}
              </Match>
              <Match when={el.type === "Link"}>
                {(() => {
                  const link = el as Extract<ModElement, { type: "Link" }>
                  const href = createMemo(() => modSafeHref(link.props.href))
                  return (
                    <Show when={href()} fallback={<span data-slot="text">{link.props.label ?? link.props.href}</span>}>
                      {(url) => (
                        <a data-slot="link" href={url()} target="_blank" rel="noopener noreferrer">
                          {link.props.label ?? link.props.href}
                        </a>
                      )}
                    </Show>
                  )
                })()}
              </Match>
              <Match when={el.type === "Code"}>
                <pre data-slot="code">
                  <code>{(el as Extract<ModElement, { type: "Code" }>).props.text}</code>
                </pre>
              </Match>
              <Match when={el.type === "Markdown"}>
                {(() => {
                  const markdown = el as Extract<ModElement, { type: "Markdown" }>
                  return (
                    <div data-slot="markdown" data-dim={markdown.props.dimColor ? "" : undefined}>
                      {props.markdown ? props.markdown(markdown.props.text) : markdown.props.text}
                    </div>
                  )
                })()}
              </Match>
              <Match when={el.type === "Input"}>
                <Field element={el as Extract<ModElement, { type: "Input" }>} events={props.events} />
              </Match>
              <Match when={el.type === "Select"}>
                {(() => {
                  const select = el as Extract<ModElement, { type: "Select" }>
                  return (
                    <div data-slot="select" role="radiogroup" aria-label={select.props.label}>
                      <Show when={select.props.label}>
                        <span data-slot="label">{select.props.label}</span>
                      </Show>
                      <div data-slot="options">
                        <For each={select.props.options}>
                          {(option) => (
                            <button
                              type="button"
                              role="radio"
                              data-slot="option"
                              aria-checked={select.props.value === option.value}
                              data-selected={select.props.value === option.value ? "" : undefined}
                              onClick={() => props.events.select(select.key, option.value)}
                            >
                              {option.label ?? option.value}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
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

/**
 * The mods' answer for one render site, asked again whenever a mod invalidates it. A mod edited on the
 * host reloads there and publishes an untargeted invalidation, which is how a window redraws it.
 */
export function createModSite(
  source: () => ModSource | undefined,
  site: () => { component: string; requestId: string; sessionID?: string; props?: Record<string, unknown> },
) {
  const [answer, setAnswer] = createSignal<ModAnswer>(undefined)
  let sequence = 0
  let settle: ReturnType<typeof setTimeout> | undefined

  const refresh = async () => {
    const src = source()
    if (!src) {
      setAnswer(undefined)
      return
    }
    const mine = ++sequence
    const out = await src.render(site()).catch(() => undefined)
    // A newer request is in flight: this answer is already out of date.
    if (mine === sequence) setAnswer(modAnswerFrom(out))
  }

  createEffect(() => {
    const src = source()
    if (!src) return
    const off = src.subscribe((event) => {
      const current = site()
      if (!modInvalidates(event, current)) return
      if (settle) return
      // Mods invalidate in bursts; draw once.
      settle = setTimeout(() => {
        settle = undefined
        void refresh()
      }, 30)
    })
    onCleanup(off)
  })

  createEffect(on([source, () => JSON.stringify(site())], () => void refresh()))
  onCleanup(() => {
    sequence++
    if (settle) clearTimeout(settle)
  })

  const events = (): ModEvents => {
    const src = source()
    const { component, requestId, sessionID } = site()
    const base = { component, requestId, sessionID }
    return {
      press: (key) => void src?.event({ kind: "press", key, ...base }).catch(() => undefined),
      input: (key, value, submit) =>
        void src?.event({ kind: "input", key, value, submit, ...base }).catch(() => undefined),
      select: (key, value) => void src?.event({ kind: "select", key, value, ...base }).catch(() => undefined),
    }
  }

  return { answer, events }
}

/**
 * One place a mod draws: a band, a pane. It shows the mods' tree when one answered, and `empty` (nothing,
 * by default) when none did — so a mod that draws only for the terminal leaves no empty block here.
 */
export function ModSite(props: {
  source: ModSource | undefined
  component: "AbovePrompt" | "Pane"
  requestId: string
  sessionID?: string
  extra?: Record<string, unknown>
  /** With a title the drawing sits in a titled block. */
  title?: string
  empty?: JSX.Element
  markdown?: (text: string) => JSX.Element
}): JSX.Element {
  const { answer, events } = createModSite(
    () => props.source,
    () => ({ component: props.component, requestId: props.requestId, sessionID: props.sessionID, props: props.extra }),
  )
  const tree = () => {
    const value = answer()
    return value && value.tree !== null && value.tree !== undefined ? value.tree : undefined
  }
  return (
    <Show when={tree()} fallback={props.empty}>
      {(node) => (
        <section data-component="mod-site" data-titled={props.title ? "" : undefined}>
          <Show when={props.title}>
            <h3 data-slot="title">{props.title}</h3>
          </Show>
          <div data-component="mod-tree">
            <ModTree node={node()} events={events()} markdown={props.markdown} />
          </div>
        </section>
      )}
    </Show>
  )
}
