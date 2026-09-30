// ADE's turn reporter for Prime Agent and pi — ade-activity
// ADE passes this file with -e when it starts one of them in a pane; it is installed nowhere.
// It tells ADE whether the agent is working, and which conversation it shows, only when ADE started it.
import { existsSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A turn that ends on a provider error is retried by the agent itself, by
 * default three times after 2, 4 and 8 seconds («Retrying (1/3) in 3s...»),
 * and the wait between attempts sends no event. Busy for this long after such
 * an end: each attempt that starts renews it, and after the last one fails the
 * pane is idle again.
 */
const RETRY_GRACE_MS =
  Number(process.env.ADE_ACTIVITY_RETRY_MS) > 0 ? Number(process.env.ADE_ACTIVITY_RETRY_MS) : 10_000

/** Why a session started, as ADE's reports name it: a later report moves the pane only for these. */
const SOURCES = { startup: "startup", new: "clear", resume: "resume", fork: "resume" }

function lastStopReason(event) {
  const messages = Array.isArray(event && event.messages) ? event.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.role === "assistant") return message.stopReason
  }
  return undefined
}

export default function adeActivity(pi) {
  const pane = process.env.ADE_PANE_ID
  const nonce = process.env.ADE_SPAWN_NONCE
  const dir = process.env.ADE_SESSION_DIR
  if (!pane || !nonce || !dir || !/^[0-9a-fA-F]{1,64}$/.test(nonce) || !existsSync(dir)) return

  // A sub-agent reuses this loader and its events arrive here too: only the first session is the pane's.
  let bound
  let active = false
  let asking = 0
  let retry
  // Silenced when its session is replaced (/new, resume, reload): the successor reports from then on.
  let gone = false
  const mine = (ctx) => !gone && (bound === undefined || (ctx && ctx.sessionManager === bound))
  const sessionIdOf = (ctx) => {
    try {
      const id = ctx && ctx.sessionManager && ctx.sessionManager.getSessionId && ctx.sessionManager.getSessionId()
      return typeof id === "string" ? id : ""
    } catch {
      return ""
    }
  }
  const put = (name, body) => {
    const target = join(dir, name)
    const staging = target + ".part"
    try {
      writeFileSync(staging, JSON.stringify(body))
      renameSync(staging, target)
    } catch {}
  }
  let last
  const write = (ctx) => {
    const state = asking > 0 ? "permission" : active || retry ? "busy" : "idle"
    const sessionId = sessionIdOf(ctx)
    last = ctx
    put(nonce + ".activity", {
      state,
      sessionId,
      cwd: ctx && typeof ctx.cwd === "string" ? ctx.cwd : "",
      at: Date.now(),
    })
  }
  const clearRetry = () => {
    if (retry) clearTimeout(retry)
    retry = undefined
  }

  pi.on("session_start", (event, ctx) => {
    if (!mine(ctx)) return
    if (bound === undefined && ctx && ctx.sessionManager !== undefined) bound = ctx.sessionManager
    try {
      active = ctx && typeof ctx.isIdle === "function" ? !ctx.isIdle() : false
    } catch {
      active = false
    }
    write(ctx)
    const source = SOURCES[event && event.reason]
    const sessionId = sessionIdOf(ctx)
    // "pi" for Prime too: it is the family, a fork of pi, and ADE takes a later
    // report only from the pane's own family (`reportFamily`, MEDIO 2).
    if (source && sessionId) put(nonce + ".json", { pane, nonce, agent: "pi", sessionId, source, at: Date.now() })
  })

  pi.on("agent_start", (_event, ctx) => {
    if (!mine(ctx)) return
    clearRetry()
    // A question left open (an Esc halfway through one) does not outlive the turn.
    asking = 0
    active = true
    write(ctx)
  })

  pi.on("agent_end", (event, ctx) => {
    if (!mine(ctx) || !active) return
    active = false
    asking = 0
    clearRetry()
    if (lastStopReason(event) === "error") {
      retry = setTimeout(() => {
        retry = undefined
        if (!active) write(ctx)
      }, RETRY_GRACE_MS)
      if (retry && typeof retry.unref === "function") retry.unref()
      return
    }
    write(ctx)
  })

  // The convention Prime's own extensions use to say they wait on the user.
  let unsubscribe
  if (pi.events && typeof pi.events.on === "function") {
    unsubscribe = pi.events.on("herdr:blocked", (data) => {
      if (gone) return
      asking = data && data.active ? asking + 1 : Math.max(0, asking - 1)
      if (last) write(last)
    })
  }

  pi.on("session_shutdown", (_event, ctx) => {
    if (!mine(ctx)) return
    gone = true
    clearRetry()
    // The event bus outlives this instance: a listener left on it would report for a session that is gone.
    if (typeof unsubscribe === "function") unsubscribe()
  })
}
