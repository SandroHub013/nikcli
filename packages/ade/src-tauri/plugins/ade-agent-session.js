// installed by ADE — ade-agent-session
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

export default { id: "ade-agent-session", tui }
