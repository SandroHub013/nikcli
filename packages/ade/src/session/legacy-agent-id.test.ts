import { describe, expect, test } from "bun:test"
import { currentAgentId } from "./legacy-agent-id"
import { CURRENT_VERSION, parseWorkspace } from "./persist"
import { parseReport } from "../session-new/agent-link"
import { agentById } from "../session-new/agents"
import { localSessionStore } from "../bots/gateway/session"
import { readAgentFile } from "../bots/ragu"

/*
 * Ragu Code was nikcli, and ADE saved its id as `nikcli`: in the panes of the
 * workspace, in a chat's session, in a bot's `runner:` line and in the reports
 * of the TUI plugin installed before the rename. Read back, each is `ragu`.
 */
describe("the agent id saved before the rename", () => {
  test("nikcli is ragu, every other id is itself", () => {
    expect(currentAgentId("nikcli")).toBe("ragu")
    expect(currentAgentId("ragu")).toBe("ragu")
    expect(currentAgentId("claude-code")).toBe("claude-code")
    expect(currentAgentId("")).toBe("")
  })

  test("a workspace saved with a nikcli pane restores a ragu pane", () => {
    const saved = JSON.stringify({
      version: CURRENT_VERSION,
      panes: [
        { id: "p1", title: "Vecchia", agent: "nikcli", cwd: "/p", branch: "main", status: "idle" },
        { id: "p2", title: "Altra", agent: "codex", cwd: "/p", branch: "main", status: "idle" },
      ],
      focusedPaneId: "p1",
      pinnedColumns: 2,
      currentView: "grid",
      sidebarWidth: 280,
    })
    expect(parseWorkspace(saved)?.panes.map((pane) => pane.agent)).toEqual(["ragu", "codex"])
  })

  test("the old TUI plugin reports as nikcli: read as ragu", () => {
    const report = JSON.stringify({ pane: "pane-1", nonce: "a1", agent: "nikcli", sessionId: "ses_1" })
    expect(parseReport(report)?.agent).toBe("ragu")
  })

  test("agentById knows the old id", () => {
    expect(agentById("nikcli")?.id).toBe("ragu")
  })

  test("a bot file with runner: nikcli runs on ragu", () => {
    const bot = readAgentFile({ path: "/cfg/agent/b.md", scope: "global", text: "---\nrunner: nikcli\n---\nCiao" })
    expect(bot.runner).toBe("ragu")
  })

  test("a chat's session saved on runner nikcli continues on ragu", () => {
    const key = `ade.gateway.sessions.test.${Math.random()}`
    localStorage.setItem(key, JSON.stringify({ chat: { project: "/p", runner: "nikcli", sessionId: "ses_1" } }))
    try {
      expect(localSessionStore(key).get("chat")).toEqual({ project: "/p", runner: "ragu", sessionId: "ses_1" })
    } finally {
      localStorage.removeItem(key)
    }
  })
})
