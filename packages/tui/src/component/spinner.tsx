import { onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { registerSpinner } from "opentui-spinner/solid"

registerSpinner()

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/**
 * `ref` for a `<spinner>`: its timer stops when the component that made it goes.
 *
 * The node normally leaves the tree with its owner and is destroyed then. Not
 * always: when the App's ErrorBoundary takes over (a session too large for the
 * native text buffers does that), the owner is disposed but the nodes on screen
 * stay where they are. The spinner's own timer kept asking for a frame every
 * interval, and every frame redrew the whole tree, for good.
 */
export function stopWhenDisposed(node: { stop(): void }) {
  onCleanup(() => node.stop())
}

export function Spinner(props: { children?: JSX.Element; color?: RGBA }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => props.color ?? theme.foreground.muted
  return (
    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <spinner ref={stopWhenDisposed} frames={frames} interval={80} color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
