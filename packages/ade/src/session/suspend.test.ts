import { describe, expect, test } from "bun:test"
import { canSuspend, offersSuspend, type SuspendContext, type SuspendPane } from "./suspend"

const pane: SuspendPane = { id: "p1", agent: "claude-code", status: "idle", resumeId: "5f0c3a52-0000-4000-8000-000000000001" }
const free: SuspendContext = {
  running: true,
  conversationMissing: false,
  permission: false,
  openRequests: [],
  heldLines: [],
  typing: false,
}

describe("canSuspend (P1-C6)", () => {
  test("a Claude session at rest, with its conversation on disk and nothing under way, can be suspended", () => {
    expect(canSuspend(pane, free)).toEqual({ ok: true })
  })

  test("each condition alone turns the command off, with its own reason", () => {
    const cases: [string, SuspendPane, SuspendContext, string][] = [
      ["another agent", { ...pane, agent: "codex" }, free, "notClaude"],
      ["already suspended", { ...pane, suspended: true }, free, "suspended"],
      ["no process", pane, { ...free, running: false }, "notRunning"],
      ["no resume id", { ...pane, resumeId: undefined }, free, "noConversation"],
      ["conversation not on disk", pane, { ...free, conversationMissing: true }, "noConversation"],
      ["working", { ...pane, status: "working" }, free, "working"],
      ["waiting", { ...pane, status: "waiting" }, free, "working"],
      ["provisioning", { ...pane, status: "provisioning" }, free, "working"],
      ["permission open", pane, { ...free, permission: true }, "permission"],
      ["a request to it", pane, { ...free, openRequests: [{ from: "p2", to: "p1" }] }, "requestTo"],
      ["a request from it", pane, { ...free, openRequests: [{ from: "p1", to: "p2" }] }, "requestFrom"],
      ["a line held for it", pane, { ...free, heldLines: [{ paneId: "p1" }] }, "held"],
      ["the user is typing", pane, { ...free, typing: true }, "typing"],
    ]
    for (const [name, candidate, ctx, reason] of cases) {
      expect({ name, check: canSuspend(candidate, ctx) }).toEqual({ name, check: { ok: false, reason } as never })
    }
  })

  test("other panes' requests and held lines do not count", () => {
    const ctx = { ...free, openRequests: [{ from: "p2", to: "p3" }], heldLines: [{ paneId: "p3" }] }
    expect(canSuspend(pane, ctx)).toEqual({ ok: true })
  })

  test("the command is offered on Claude sessions only", () => {
    expect(offersSuspend(pane)).toBe(true)
    expect(offersSuspend({ agent: "codex" })).toBe(false)
    expect(offersSuspend({})).toBe(false)
    expect(offersSuspend(undefined)).toBe(false)
  })
})
