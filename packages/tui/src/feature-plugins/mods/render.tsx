import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createRoot, createSignal, on, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import type { ModNode } from "@nikcli-ai/plugin/mod"
import { useSDK } from "@tui/context/sdk"
import { Tree, type TreeEvents } from "./tree"

/**
 * Asking the mods what to draw, shared by every render site.
 *
 * A site is a `component` name and a `requestId`; the answer is a drawing (`tree`), or "draw the default"
 * with the props as the mods left them. A site that replaces something nikcli already draws — a tool
 * row, a message, the question dialog — is `Replace`: it draws its children unless a mod answered with a
 * tree, so nothing changes for a user with no mod that draws.
 */

export type Answer = { tree: ModNode } | { props: Record<string, unknown> } | undefined

/**
 * Whether any loaded mod hooks `ui.render`. Read once per client and kept current: a mod loading or
 * unloading publishes an untargeted `mod.ui.invalidate`. Replace sites sit on every message and tool row,
 * so they must not each ask the server when no mod could answer.
 */
const hooked = new WeakMap<object, Accessor<boolean>>()

function useHooked(): Accessor<boolean> {
  const sdk = useSDK()
  const existing = hooked.get(sdk.client)
  if (existing) return existing
  return createRoot(() => {
    const [value, setValue] = createSignal(false)
    const load = async () => {
      const out = await sdk.client.mod.list().catch(() => undefined)
      if (out?.data) setValue(out.data.some((mod) => mod.events.includes("ui.render")))
    }
    void load()
    sdk.event.on("mod.ui.invalidate", (event) => {
      if (!event.properties.component && !event.properties.requestID) void load()
    })
    hooked.set(sdk.client, value)
    return value
  })
}

/** The mods' answer for one site, asked again whenever a mod invalidates it. */
export function useAnswer(site: {
  component: string
  requestId: () => string
  sessionID: () => string | undefined
  props?: () => Record<string, unknown>
  /** Ask even when no mod is known to hook `ui.render` (the band and panes are drawn by mods alone). */
  always?: boolean
}) {
  const sdk = useSDK()
  const dimensions = useTerminalDimensions()
  const anyHooked = useHooked()
  const [answer, setAnswer] = createSignal<Answer>(undefined)
  let sequence = 0
  let settle: ReturnType<typeof setTimeout> | undefined

  const refresh = async () => {
    if (!site.always && !anyHooked()) {
      setAnswer(undefined)
      return
    }
    const mine = ++sequence
    const out = await sdk.client.mod
      .render({
        component: site.component,
        requestId: site.requestId(),
        sessionID: site.sessionID(),
        props: JSON.stringify({ bodyColumns: dimensions().width, ...site.props?.() }),
        columns: dimensions().width,
        rows: dimensions().height,
      })
      .catch(() => undefined)
    // A newer request is in flight: this answer is already out of date.
    if (mine !== sequence || !out?.data) return
    if (out.data.kind === "tree") {
      setAnswer({ tree: out.data.tree ? (JSON.parse(out.data.tree) as ModNode) : null })
    } else {
      setAnswer(out.data.props ? { props: JSON.parse(out.data.props) as Record<string, unknown> } : undefined)
    }
  }

  const schedule = () => {
    if (settle) return
    // Mods invalidate in bursts; draw once.
    settle = setTimeout(() => {
      settle = undefined
      void refresh()
    }, 30)
  }

  const off = sdk.event.on("mod.ui.invalidate", (event) => {
    const target = event.properties
    if (target.component && target.component !== site.component) return
    if (target.requestID && target.requestID !== site.requestId()) return
    schedule()
  })
  onCleanup(() => {
    off()
    if (settle) clearTimeout(settle)
    sequence++
  })

  createEffect(on([site.sessionID, anyHooked, site.requestId], () => void refresh()))

  const events = (): TreeEvents => {
    const base = { component: site.component, requestId: site.requestId(), sessionID: site.sessionID() }
    return {
      press: (key) => void sdk.client.mod.event({ kind: "press", key, ...base }),
      input: (key, value, submit) => void sdk.client.mod.event({ kind: "input", key, value, submit, ...base }),
      select: (key, value) => void sdk.client.mod.event({ kind: "select", key, value, ...base }),
    }
  }

  return { answer, events }
}

/** The client, or `undefined` where there is none (a story, a component test): nothing can draw there. */
function maybeSDK() {
  try {
    return useSDK()
  } catch {
    return undefined
  }
}

/**
 * Draw `children` as nikcli always did, unless a mod answers this site with a tree. A mod that only
 * rewrites props passes them to `children` when it is a function; otherwise they are ignored. Without a
 * client there is nobody to ask, and this is its children.
 */
export function Replace(props: {
  component: string
  requestId: string
  sessionID?: string
  props?: Record<string, unknown>
  children: JSX.Element | ((props: Record<string, unknown>) => JSX.Element)
}) {
  if (!maybeSDK()) {
    return typeof props.children === "function" ? props.children(props.props ?? {}) : props.children
  }
  return <Asking {...props} />
}

function Asking(props: {
  component: string
  requestId: string
  sessionID?: string
  props?: Record<string, unknown>
  children: JSX.Element | ((props: Record<string, unknown>) => JSX.Element)
}) {
  const { answer, events } = useAnswer({
    component: props.component,
    requestId: () => props.requestId,
    sessionID: () => props.sessionID,
    props: () => props.props ?? {},
  })
  const drawn = () => {
    const value = answer()
    return value && "tree" in value ? value : undefined
  }
  const rewritten = () => {
    const value = answer()
    return { ...(props.props ?? {}), ...(value && "props" in value ? value.props : {}) }
  }
  return (
    <Show when={drawn()} fallback={typeof props.children === "function" ? props.children(rewritten()) : props.children}>
      {(value) => (
        <Show when={value().tree !== null && value().tree !== undefined ? value().tree : undefined}>
          {(node) => <Tree node={node()} events={events()} />}
        </Show>
      )}
    </Show>
  )
}
