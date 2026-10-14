// installed by ADE — ade-agent-session
// ADE overwrites this file when the integration is reinstalled, and removes it when it is switched off.
// It tells ADE which conversation this ragu TUI shows, and whether that conversation is in a turn, and only when ADE started the TUI.
import { existsSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

async function tui(api, options) {
  const pane = process.env.ADE_PANE_ID
  const nonce = process.env.ADE_SPAWN_NONCE
  const dir = process.env.ADE_SESSION_DIR
  if (!pane || !nonce || !dir || !/^[0-9a-fA-F]{1,64}$/.test(nonce) || !existsSync(dir)) return
  const every = options && typeof options.intervalMs === "number" ? options.intervalMs : 1000
  const put = (name, body) => {
    const target = join(dir, name)
    const staging = target + ".part"
    try {
      writeFileSync(staging, JSON.stringify(body))
      renameSync(staging, target)
    } catch {}
  }
  let last
  // The pane's own conversation: the last one on screen that is not a child's.
  let mine
  let sessionDir
  const check = async () => {
    const route = api.route.current
    const sessionID = route && route.name === "session" && route.params ? route.params.sessionID : undefined
    if (typeof sessionID !== "string" || !sessionID || sessionID === last) return
    last = sessionID
    let found
    try {
      const got = await api.client.session.get({ sessionID })
      const info = got && got.data ? got.data : got
      if (info && info.parentID) return
      if (info && typeof info.directory === "string") found = info.directory
    } catch {}
    mine = sessionID
    sessionDir = found
    const report = { pane, nonce, agent: "ragu", sessionId: sessionID, at: Date.now(), source: "switch" }
    if (found) report.sessionDir = found
    put(nonce + ".json", report)
  }
  /*
   * Whether the conversation is in a turn, from the TUI's own state rather than from what it prints.
   *
   * ADE used to guess it from the terminal going quiet, and a TUI that repaints without end (a resumed one, a
   * spinner) was never quiet: «working» for hours with the server idle. `status` is what the TUI itself draws its
   * «esc interrompi» from, and a pending permission or question is a prompt waiting on a key: ADE types nothing
   * into it. Written when it changes, in the report format of the hook and the extension (`<nonce>.activity`);
   * a TUI that does not offer the state writes nothing, and ADE goes on guessing.
   */
  let state
  const turn = () => {
    if (!mine) return
    const session = api.state && api.state.session
    if (!session || typeof session.status !== "function") return
    let now = "idle"
    try {
      const status = session.status(mine)
      if (status && status.type && status.type !== "idle") now = "busy"
      const asked = (typeof session.permission === "function" ? session.permission(mine) : []) || []
      const questions = (typeof session.question === "function" ? session.question(mine) : []) || []
      if (asked.length > 0 || questions.length > 0) now = "permission"
    } catch {
      return
    }
    if (now === state) return
    state = now
    put(nonce + ".activity", { state: now, sessionId: mine, cwd: sessionDir || "", at: Date.now() })
  }
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    check()
      .then(turn)
      .finally(() => {
        busy = false
      })
  }
  tick()
  const timer = setInterval(tick, every)
  if (timer && typeof timer.unref === "function") timer.unref()
  api.lifecycle.onDispose(() => clearInterval(timer))
}

export default { id: "ade-agent-session", tui }
