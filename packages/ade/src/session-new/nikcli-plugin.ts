/**
 * The nikcli TUI plugin that tells ADE which conversation the TUI shows.
 *
 * nikcli has no hooks in its config, as Claude Code and codex do, so the
 * report comes from a plugin of its TUI instead. A server plugin would not
 * do: switching tab does not reach the server. The TUI gives its plugins the
 * route on screen, `{ name: "session", params: { sessionID } }`, which moves
 * with `/new`, `/sessions`, a tab and «+ new» alike.
 *
 * The file goes in `<nikcli config>/plugin/tui/`, which the TUI scans for
 * plugins (`plugin/` itself belongs to the server's loader and is not read
 * recursively, so the two never meet). Plain JavaScript with only Node's
 * built-ins: `@nikcli-ai/plugin` is not on npm, and a plugin that needed it
 * would not load.
 *
 * It does nothing unless ADE started this TUI: without `ADE_PANE_ID`,
 * `ADE_SPAWN_NONCE` and `ADE_SESSION_DIR` it returns at once, so a nikcli the
 * user starts by hand, or the one behind ADE's Chat, is left alone. When it
 * runs, it checks the route once a second and writes the report of
 * `agent-link.ts` (`source: "switch"`, with the conversation's folder) when
 * the conversation changes: a poll, because a reactive effect would need the
 * TUI's own `solid-js`. The report is written beside its place and moved in,
 * so ADE never reads half of one. A child conversation is not reported: the
 * pane is the parent's.
 */

import { HOOK_MARKER } from "./agent-hooks"

/** The plugin's file name: the marker, so ADE finds its own file again. */
export const NIKCLI_PLUGIN_NAME = `${HOOK_MARKER}.js`

/** The plugin's source, as ADE writes it. */
export function nikcliPluginScript(): string {
  return `// installed by ADE — ${HOOK_MARKER}
// ADE overwrites this file when the integration is reinstalled, and removes it when it is switched off.
// It tells ADE which conversation this nikcli TUI shows, and only when ADE started the TUI.
import { existsSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

async function tui(api, options) {
  const pane = process.env.ADE_PANE_ID
  const nonce = process.env.ADE_SPAWN_NONCE
  const dir = process.env.ADE_SESSION_DIR
  if (!pane || !nonce || !dir || !/^[0-9a-fA-F]{1,64}$/.test(nonce) || !existsSync(dir)) return
  const every = options && typeof options.intervalMs === "number" ? options.intervalMs : 1000
  let last
  const check = async () => {
    const route = api.route.current
    const sessionID = route && route.name === "session" && route.params ? route.params.sessionID : undefined
    if (typeof sessionID !== "string" || !sessionID || sessionID === last) return
    last = sessionID
    let sessionDir
    try {
      const got = await api.client.session.get({ sessionID })
      const info = got && got.data ? got.data : got
      if (info && info.parentID) return
      if (info && typeof info.directory === "string") sessionDir = info.directory
    } catch {}
    const report = { pane, nonce, agent: "nikcli", sessionId: sessionID, at: Date.now(), source: "switch" }
    if (sessionDir) report.sessionDir = sessionDir
    const target = join(dir, nonce + ".json")
    const staging = target + ".part"
    try {
      writeFileSync(staging, JSON.stringify(report))
      renameSync(staging, target)
    } catch {}
  }
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    check().finally(() => {
      busy = false
    })
  }
  tick()
  const timer = setInterval(tick, every)
  if (timer && typeof timer.unref === "function") timer.unref()
  api.lifecycle.onDispose(() => clearInterval(timer))
}

export default { id: "${HOOK_MARKER}", tui }
`
}
