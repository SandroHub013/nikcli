import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseActivity, statusFromActivity } from "../session/mailbox"
import { acceptsLaterReport, parseReport } from "./agent-link"
import {
  ACTIVITY_EXTENSION_AGENTS,
  ACTIVITY_EXTENSION_NAME,
  ACTIVITY_EXTENSION_SOURCE,
  reportsTurns,
  takesActivityExtension,
} from "./agent-hooks"

/*
 * The turn reporter for Prime Agent and pi, as they load it: the file Rust
 * compiles in, imported, its default export called with a stand-in for the
 * extension API — `on(event, handler)` and an event bus — and the reports
 * landing in a real folder. Fake pane, nonce and session ids throughout.
 *
 * Proven live on 2026-09-28 as well: pi and Prime (private daemon, a :free
 * model) started with `-e` on this file wrote idle at start, busy on the turn,
 * idle at its end, and the `.json` report, Prime's from its daemon worker.
 */

const ENV = ["ADE_PANE_ID", "ADE_SPAWN_NONCE", "ADE_SESSION_DIR", "ADE_ACTIVITY_RETRY_MS"] as const
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]))
const dirs: string[] = []

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Handler = (event: unknown, ctx: unknown) => void

let loads = 0
async function load(env: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "ade-activity-ext-"))
  dirs.push(dir)
  const file = join(dir, `${loads++}-${ACTIVITY_EXTENSION_NAME}`)
  writeFileSync(file, readFileSync(new URL(ACTIVITY_EXTENSION_SOURCE, import.meta.url), "utf8"))
  if (env) {
    process.env.ADE_PANE_ID = "pane-test"
    process.env.ADE_SPAWN_NONCE = "abc123"
    process.env.ADE_SESSION_DIR = dir
  }
  process.env.ADE_ACTIVITY_RETRY_MS = "60"
  const module = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void }
  const handlers = new Map<string, Handler>()
  const bus = new Map<string, (data: unknown) => void>()
  let unsubscribed = 0
  module.default({
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    events: {
      on: (event: string, handler: (data: unknown) => void) => {
        bus.set(event, handler)
        return () => void unsubscribed++
      },
    },
  })
  const manager = { getSessionId: () => "sess-1" }
  const ctx = { sessionManager: manager, cwd: "C:/w", isIdle: () => true }
  const fire = (event: string, payload: unknown = {}, context: unknown = ctx) => handlers.get(event)?.(payload, context)
  const activity = () =>
    parseActivity(existsSync(join(dir, "abc123.activity")) ? readFileSync(join(dir, "abc123.activity"), "utf8") : null)
  const report = () =>
    existsSync(join(dir, "abc123.json")) ? parseReport(readFileSync(join(dir, "abc123.json"), "utf8")) : undefined
  return { dir, handlers, bus, fire, activity, report, ctx, unsubscribed: () => unsubscribed }
}

const end = (stopReason: string) => ({ messages: [{ role: "user" }, { role: "assistant", stopReason }] })

describe("the turn reporter ADE passes to Prime and pi", () => {
  test("outside ADE it listens to nothing", async () => {
    for (const name of ENV) delete process.env[name]
    const ext = await load(false)
    expect(ext.handlers.size).toBe(0)
  })

  test("a session starting says idle, and which conversation it is", async () => {
    const ext = await load(true)
    ext.fire("session_start", { reason: "startup" })
    expect(ext.activity()).toMatchObject({ state: "idle", cwd: "C:/w" })
    expect(ext.report()).toMatchObject({ pane: "pane-test", nonce: "abc123", sessionId: "sess-1", source: "startup" })
    // A /new is a new conversation the pane follows, like Claude Code's `clear`.
    ext.fire("session_start", { reason: "new" })
    expect(acceptsLaterReport(ext.report()!, "sess-0")).toBe(true)
  })

  test("a turn is busy from its start to its end, and the pane follows", async () => {
    const ext = await load(true)
    ext.fire("session_start", { reason: "startup" })
    ext.fire("agent_start")
    const busy = ext.activity()!
    expect(busy.state).toBe("busy")
    expect(statusFromActivity("idle", busy, undefined)).toBe("working")
    ext.fire("agent_end", end("stop"))
    expect(ext.activity()!.state).toBe("idle")
    // An Esc ends the turn too: pi sends agent_end with «aborted».
    ext.fire("agent_start")
    ext.fire("agent_end", end("aborted"))
    expect(ext.activity()!.state).toBe("idle")
  })

  test("a provider error keeps it busy while the agent retries, then lets go", async () => {
    const ext = await load(true)
    ext.fire("session_start", { reason: "startup" })
    ext.fire("agent_start")
    ext.fire("agent_end", end("error"))
    // «Retrying (1/3) in 3s...»: no event until the next attempt.
    expect(ext.activity()!.state).toBe("busy")
    await Bun.sleep(150)
    expect(ext.activity()!.state).toBe("idle")
  })

  test("a sub-agent's turns are not the pane's", async () => {
    const ext = await load(true)
    ext.fire("session_start", { reason: "startup" })
    const child = { sessionManager: { getSessionId: () => "child" }, cwd: "C:/w", isIdle: () => true }
    ext.fire("agent_start", {}, child)
    expect(ext.activity()!.state).toBe("idle")
  })

  test("a question the agent's own extensions announce is a permission", async () => {
    const ext = await load(true)
    ext.fire("session_start", { reason: "startup" })
    ext.fire("agent_start")
    ext.bus.get("herdr:blocked")!({ active: true, label: "Bash?" })
    expect(ext.activity()!.state).toBe("permission")
    ext.bus.get("herdr:blocked")!({ active: false })
    expect(ext.activity()!.state).toBe("busy")
  })

  test("a replaced session goes quiet, and lets go of the event bus", async () => {
    const ext = await load(true)
    ext.fire("session_start", { reason: "startup" })
    ext.fire("session_shutdown", { reason: "new" })
    ext.fire("agent_start")
    expect(ext.activity()!.state).toBe("idle")
    expect(ext.unsubscribed()).toBe(1)
  })
})

describe("which agents get it, here and in Rust", () => {
  test("prime and pi, reporting turns without any hook installed", () => {
    expect([...ACTIVITY_EXTENSION_AGENTS]).toEqual(["prime", "pi"])
    expect(takesActivityExtension("prime")).toBe(true)
    expect(reportsTurns("pi")).toBe(true)
    expect(reportsTurns("claude-code")).toBe(true)
    expect(reportsTurns("opencode")).toBe(false)
  })

  test("the same list, file and text in agent_link.rs", () => {
    const rust = readFileSync(new URL("../../src-tauri/src/agent_link.rs", import.meta.url), "utf8")
    expect(rust).toContain('const ACTIVITY_EXTENSION_AGENTS: &[&str] = &["prime", "pi"];')
    expect(rust).toContain(`const ACTIVITY_EXTENSION_NAME: &str = "${ACTIVITY_EXTENSION_NAME}";`)
    expect(rust).toContain('include_str!("../plugins/ade-activity.js")')
    expect(ACTIVITY_EXTENSION_SOURCE.endsWith("/src-tauri/plugins/ade-activity.js")).toBe(true)
  })

  test("lint: a spawn with a nonce gets -e, added after check_args and before launch_plan", () => {
    const pty = readFileSync(new URL("../../src-tauri/src/pty.rs", import.meta.url), "utf8")
    const check = pty.indexOf("check_args(&command, &args)?")
    const added = pty.indexOf("crate::agent_link::activity_extension(&app, command_stem(&command))")
    const plan = pty.indexOf("let (program, args) = launch_plan(&resolved, &args)?")
    expect(check).toBeGreaterThan(0)
    expect(added).toBeGreaterThan(check)
    expect(plan).toBeGreaterThan(added)
    const workbench = readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8")
    expect(workbench).toContain("|| takesActivityExtension(agentId)")
  })
})
