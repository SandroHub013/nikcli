import { Plugin } from "@nikcli-ai/plugin/v2/tui"
import { createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import type { ModNode } from "@nikcli-ai/plugin/mod"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useAnswer } from "./render"
import { Tree } from "./tree"

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

/** A render site the mods draw alone (nikcli draws nothing there): the band above the prompt, a pane. */
export function Site(props: {
  component: "AbovePrompt" | "Pane"
  requestId: string
  sessionID?: string
  extra?: Record<string, unknown>
  empty?: JSX.Element
}) {
  const { answer, events } = useAnswer({
    component: props.component,
    requestId: () => props.requestId,
    sessionID: () => props.sessionID,
    props: () => props.extra ?? {},
    always: true,
  })
  const tree = () => {
    const value = answer()
    return value && "tree" in value ? (value.tree ?? undefined) : undefined
  }
  return (
    <Show when={tree()} fallback={props.empty}>
      {(node) => <Tree node={node()} events={events()} />}
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
