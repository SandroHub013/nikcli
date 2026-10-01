import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { activityOrFormer, parseActivity } from "../session/mailbox"
import { acceptsLaterReport, followReports, lastReportedId, parseReport } from "./agent-link"
import { ACTIVITY_EXTENSION_NAME, ACTIVITY_EXTENSION_SOURCE, reportFamily } from "./agent-hooks"

/*
 * The Architect's review of activity-prime-pi (ade-team/results/activity-prime-pi-review.md):
 * MEDIO 1, MEDIO 2, BASSO 3 and BASSO 5. Fake pane, nonce and session ids throughout.
 */

const activity = (fields: Record<string, unknown>) => JSON.stringify({ state: "busy", at: 1, ...fields })

describe("MEDIO 1: a resumed Prime pane reads the worker that outlived ADE", () => {
  test("this spawn's file wins as soon as it exists", () => {
    const current = activity({ state: "idle", sessionId: "sess-1" })
    expect(activityOrFormer(current, activity({ sessionId: "sess-1" }), "sess-1")?.state).toBe("idle")
  })

  test("while it is silent, the previous spawn's file speaks for the pane's own conversation", () => {
    expect(activityOrFormer(null, activity({ sessionId: "sess-1" }), "sess-1")?.state).toBe("busy")
  })

  test("and only for it: another conversation, no id, or no id to compare with are not believed", () => {
    expect(activityOrFormer(null, activity({ sessionId: "sess-2" }), "sess-1")).toBeUndefined()
    expect(activityOrFormer(null, activity({}), "sess-1")).toBeUndefined()
    expect(activityOrFormer(null, activity({ sessionId: "sess-1" }), undefined)).toBeUndefined()
    expect(activityOrFormer(null, "non json", "sess-1")).toBeUndefined()
    expect(activityOrFormer(null, null, "sess-1")).toBeUndefined()
  })

  test("lint: every read of a pane's activity goes through the fallback", () => {
    const workbench = readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8")
    expect(workbench).not.toContain("parseActivity(")
    expect(workbench.match(/await paneActivity\(host, paneId, /g)).toHaveLength(3)
    // Kept for Prime and pi only, from the nonce saved with the pane.
    expect(workbench).toContain("formerNonce !== nonce && takesActivityExtension(agentId)")
  })
})

describe("MEDIO 2: a later report counts only from the pane's own family", () => {
  const report = (agent: string, sessionId: string, source: string) =>
    JSON.stringify({ pane: "pane-test", nonce: "abc123", agent, sessionId, source, at: 1 })

  test("the family is what each pane's own CLI writes", () => {
    expect(reportFamily("prime")).toBe("pi")
    expect(reportFamily("pi")).toBe("pi")
    expect(reportFamily("claude-code")).toBe("claude")
    expect(reportFamily("nikcli")).toBe("nikcli")
    expect(reportFamily("opencode")).toBeUndefined()
  })

  test("a Claude started from a Prime pane does not move it onto a Claude conversation", () => {
    expect(acceptsLaterReport(parseReport(report("claude", "claude-conv", "resume"))!, "sess-1", "pi")).toBe(false)
    expect(acceptsLaterReport(parseReport(report("pi", "sess-2", "resume"))!, "sess-1", "pi")).toBe(true)
    // Without a family, as before.
    expect(acceptsLaterReport(parseReport(report("claude", "claude-conv", "resume"))!, "sess-1")).toBe(true)
  })

  test("the follow and the report read at the next start apply it", async () => {
    const files = [
      report("pi", "sess-1", "startup"),
      report("claude", "claude-conv", "resume"),
      report("pi", "sess-2", "new"),
    ]
    let polls = 0
    let at = 0
    const seen: string[] = []
    await followReports({
      pane: "pane-test",
      nonce: "abc123",
      family: "pi",
      read: async () => files[polls++] ?? null,
      clear: async () => {},
      cancelled: () => polls >= files.length + 1,
      onReport: (r) => void seen.push(r.sessionId),
      now: () => at,
      sleep: async (ms) => void (at += ms),
    })
    // `new` is not a later reason; only the first report stands.
    expect(seen).toEqual(["sess-1"])
    const expected = { pane: "pane-test", nonce: "abc123" }
    expect(lastReportedId(report("claude", "claude-conv", "resume"), expected, "sess-1", "pi")).toBeUndefined()
    expect(lastReportedId(report("pi", "sess-2", "resume"), expected, "sess-1", "pi")).toBe("sess-2")
  })

  test("lint: the workbench passes the family to both", () => {
    const workbench = readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8")
    expect(workbench).toContain("...(family ? { family } : {}),")
    expect(workbench).toContain('pane.resumeId, reportFamily(pane.agent ?? ""))')
  })
})

describe("BASSO 3 and 5: the extension", () => {
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

  let loads = 0
  async function load() {
    const dir = mkdtempSync(join(tmpdir(), "ade-activity-review-"))
    dirs.push(dir)
    const file = join(dir, `${loads++}-${ACTIVITY_EXTENSION_NAME}`)
    writeFileSync(file, readFileSync(new URL(ACTIVITY_EXTENSION_SOURCE, import.meta.url), "utf8"))
    process.env.ADE_PANE_ID = "pane-test"
    process.env.ADE_SPAWN_NONCE = "abc123"
    process.env.ADE_SESSION_DIR = dir
    process.env.ADE_ACTIVITY_RETRY_MS = "60"
    const module = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void }
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>()
    const bus = new Map<string, (data: unknown) => void>()
    module.default({
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => void handlers.set(event, handler),
      events: {
        on: (event: string, handler: (data: unknown) => void) => {
          bus.set(event, handler)
          return () => {}
        },
      },
    })
    const ctx = { sessionManager: { getSessionId: () => "sess-1" }, cwd: "C:/w", isIdle: () => true }
    const fire = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx)
    const state = () => {
      const path = join(dir, "abc123.activity")
      return parseActivity(existsSync(path) ? readFileSync(path, "utf8") : null)?.state
    }
    const report = () => {
      const path = join(dir, "abc123.json")
      return existsSync(path) ? parseReport(readFileSync(path, "utf8")) : undefined
    }
    return { fire, bus, state, report }
  }

  const end = { messages: [{ role: "assistant", stopReason: "stop" }] }

  test("a question announced and never closed does not outlive its turn", async () => {
    const ext = await load()
    ext.fire("session_start", { reason: "startup" })
    ext.fire("agent_start")
    ext.bus.get("herdr:blocked")!({ active: true, label: "Bash?" })
    expect(ext.state()).toBe("permission")
    // An Esc halfway through the question: no closing event.
    ext.fire("agent_end", end)
    expect(ext.state()).toBe("idle")
    ext.fire("agent_start")
    expect(ext.state()).toBe("busy")
  })

  test("the next turn starts clean even when the end never came", async () => {
    const ext = await load()
    ext.fire("session_start", { reason: "startup" })
    ext.bus.get("herdr:blocked")!({ active: true })
    ext.fire("agent_start")
    expect(ext.state()).toBe("busy")
  })

  test("Prime's report says pi, the family ADE compares", async () => {
    const ext = await load()
    ext.fire("session_start", { reason: "startup" })
    expect(ext.report()?.agent).toBe(reportFamily("prime"))
  })
})
