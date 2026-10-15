import { Plugin } from "@ragu/plugin/v2/tui"
import { createMemo, Show } from "solid-js"
import { Global } from "@ragu/util/global"
import { VERSION } from "@ragu/util/version"
import { shortVersion } from "@tui/util/product-name"
import { sidebarPath } from "@tui/util/sidebar-path"
import { useKV } from "@tui/context/kv"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"

function View() {
  const kv = useKV()
  const sync = useSync()
  const theme = useTheme().theme
  const hasProvider = createMemo(() =>
    sync.data.provider.some(
      (item) => item.id !== "ragu" || Object.values(item.models).some((model) => model.cost?.input !== 0),
    ),
  )
  const showGettingStarted = createMemo(() => !hasProvider() && !kv.get("dismissed_getting_started", false))
  const path = createMemo(() => {
    const value = (sync.data.path.directory || process.cwd()).replace(Global.Path.home, "~")
    return sidebarPath(value, sync.data.vcs?.branch)
  })

  return (
    <box gap={1}>
      <Show when={showGettingStarted()}>
        <box
          backgroundColor={theme.surface.offset}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          flexDirection="row"
          gap={1}
        >
          <text flexShrink={0} fg={theme.foreground.default}>
            ⬖
          </text>
          <box flexGrow={1} gap={1}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme.foreground.default}>
                <b>Getting started</b>
              </text>
              <text fg={theme.foreground.muted} onMouseDown={() => kv.set("dismissed_getting_started", true)}>
                ✕
              </text>
            </box>
            <text fg={theme.foreground.muted}>
              Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
            </text>
            <box flexDirection="row" gap={1} justifyContent="space-between">
              <text fg={theme.foreground.default}>Connect provider</text>
              <text fg={theme.foreground.muted}>/connect</text>
            </box>
          </box>
        </box>
      </Show>
      <text>
        <span style={{ fg: theme.foreground.muted }}>{path().parent}</span>
        <span style={{ fg: theme.foreground.default }}>{path().name}</span>
      </text>
      <text fg={theme.foreground.muted}>
        <span style={{ fg: theme.status.success.fg }}>•</span> <b>Ragu Code</b> <span>{shortVersion(VERSION)}</span>
      </text>
    </box>
  )
}

export default Plugin.define({
  id: "internal:sidebar-footer",
  setup(ctx) {
    ctx.ui.slot("sidebar.footer", () => <View />)
  },
})
