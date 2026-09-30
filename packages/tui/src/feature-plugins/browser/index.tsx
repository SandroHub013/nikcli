/**
 * Browser control — internal TUI plugin.
 *
 * Mirrors `feature-plugins/loops`: wires the local browser-control integration
 * (see `src/browser-control/`, backed by `@nikcli-ai/browser-control`) into the
 * TUI as a self-contained plugin instead of a hard-coded command in `app.tsx`.
 * Registers the `/browser` slash command that opens a dialog listing active
 * background browser sessions.
 *
 * A v2 plugin (`specs/effect-tui/14-plugin-v2-architecture.md`): the first
 * internal plugin that registers a command rather than a slot.
 */
import { Plugin } from "@nikcli-ai/plugin/v2/tui"
import { DialogBrowserControl } from "@tui/component/dialog-browser-control"

export default Plugin.define({
  id: "internal:browser",
  setup(ctx) {
    ctx.ui.command({
      name: "browser.sessions",
      title: "Browser Control",
      namespace: "Tool",
      description: "Inspect and manage active background browser sessions",
      slash: { name: "browser" },
      run() {
        ctx.ui.dialog.replace(() => <DialogBrowserControl />)
      },
    })
  },
})
