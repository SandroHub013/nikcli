import { Plugin } from "@nikcli-ai/plugin/v2/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js"
import type { ModNode } from "@nikcli-ai/plugin/mod"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { Tree, type TreeEvents } from "./tree"

/**
 * Where mods draw: the band above the prompt and panes.
 *
 * Mods run in the server and the terminal asks them what to draw at each site (`POST /mod/ui/render`),
 * then reports presses and typing back (`POST /mod/ui/event`). Nothing here knows what a mod is: a site
 * is a request id, and a tree is what came back. A mod asks to be drawn again with `$.ui.invalidate`,
 * which arrives as `mod.ui.invalidate`; panes opening and closing arrive as `mod.ui.panes`.
 *
 * `AbovePrompt` is the `session.prompt.top` slot. A `dock` pane is the sidebar, an `inline` pane sits
 * above the prompt under the band, scrolling past its `rows`.
 */

type Pane = { id: string; plugin: string; title: string; placement: "dock" | "inline"; rows?: number }

/** A render site: asks the mods what to draw and draws it, again whenever a mod invalidates it. */
export function Site(props: {
  component: "AbovePrompt" | "Pane"
  requestId: string
  sessionID?: string
  extra?: Record<string, unknown>
  empty?: JSX.Element
}) {
  const sdk = useSDK()
  const dimensions = useTerminalDimensions()
  const [tree, setTree] = createSignal<ModNode | undefined>(undefined)
  let sequence = 0
  let settle: ReturnType<typeof setTimeout> | undefined

  const refresh = async () => {
    const mine = ++sequence
    const out = await sdk.client.mod
      .render({
        component: props.component,
        requestId: props.requestId,
        sessionID: props.sessionID,
        props: JSON.stringify({ bodyColumns: dimensions().width, ...props.extra }),
        columns: dimensions().width,
        rows: dimensions().height,
      })
      .catch(() => undefined)
    // A newer request is in flight: this answer is already out of date.
    if (mine !== sequence || !out?.data) return
    if (out.data.kind === "tree") setTree(out.data.tree ? (JSON.parse(out.data.tree) as ModNode) : undefined)
    else setTree(undefined)
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
    if (target.component && target.component !== props.component) return
    if (target.requestID && target.requestID !== props.requestId) return
    schedule()
  })
  onCleanup(() => {
    off()
    if (settle) clearTimeout(settle)
    sequence++
  })

  createEffect(
    on(
      () => props.sessionID,
      () => void refresh(),
    ),
  )

  const events: TreeEvents = {
    press: (key) =>
      void sdk.client.mod.event({
        kind: "press",
        key,
        component: props.component,
        requestId: props.requestId,
        sessionID: props.sessionID,
      }),
    input: (key, value, submit) =>
      void sdk.client.mod.event({
        kind: "input",
        key,
        value,
        submit,
        component: props.component,
        requestId: props.requestId,
        sessionID: props.sessionID,
      }),
    select: (key, value) =>
      void sdk.client.mod.event({
        kind: "select",
        key,
        value,
        component: props.component,
        requestId: props.requestId,
        sessionID: props.sessionID,
      }),
  }

  return (
    <Show when={tree() !== undefined && tree() !== null ? tree() : undefined} fallback={props.empty}>
      {(node) => <Tree node={node()} events={events} />}
    </Show>
  )
}

/** The panes mods have open, kept in step with `mod.ui.panes`. */
function usePanes() {
  const sdk = useSDK()
  const [panes, setPanes] = createSignal<Pane[]>([])
  const load = async () => {
    const out = await sdk.client.mod.panes().catch(() => undefined)
    if (out?.data) setPanes(out.data as Pane[])
  }
  void load()
  const off = sdk.event.on("mod.ui.panes", () => void load())
  onCleanup(off)
  return panes
}

function Titled(props: { title: string; children: JSX.Element }) {
  const { theme } = useTheme()
  return (
    <box>
      <text fg={theme.foreground.default}>
        <b>{props.title}</b>
      </text>
      {props.children}
    </box>
  )
}

function Band(props: { sessionID: string }) {
  const sync = useSync()
  const panes = usePanes()
  const inline = () => panes().filter((pane) => pane.placement === "inline")
  return (
    <box flexShrink={0}>
      <Site
        component="AbovePrompt"
        requestId="band"
        sessionID={props.sessionID}
        extra={{ isWorking: sync.data.session_status[props.sessionID]?.type === "busy", maxRows: 8 }}
      />
      <For each={inline()}>
        {(pane) => (
          <Titled title={pane.title}>
            <scrollbox maxHeight={pane.rows ?? 8}>
              <Site
                component="Pane"
                requestId={pane.id}
                sessionID={props.sessionID}
                extra={{ title: pane.title, placement: "inline" }}
              />
            </scrollbox>
          </Titled>
        )}
      </For>
    </box>
  )
}

function Docked(props: { sessionID: string }) {
  const panes = usePanes()
  return (
    <For each={panes().filter((pane) => pane.placement === "dock")}>
      {(pane) => (
        <Titled title={pane.title}>
          <Site
            component="Pane"
            requestId={pane.id}
            sessionID={props.sessionID}
            extra={{ title: pane.title, placement: "dock" }}
          />
        </Titled>
      )}
    </For>
  )
}

export default Plugin.define({
  id: "internal:mods-ui",
  setup(ctx) {
    ctx.ui.slot("session.prompt.top", (props) => <Band sessionID={String(props.sessionID)} />)
    ctx.ui.slot("sidebar.content", (props) => <Docked sessionID={String(props.sessionID)} />)
  },
})
