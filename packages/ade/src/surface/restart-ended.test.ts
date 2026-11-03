import { describe, expect, test } from "bun:test"
import { parseWorkspace, serializeWorkspace } from "../session/persist"
import { createWorkbench, fromWorkspaceState, liveToReopen, sessionsToResume, toWorkspaceState, type Pane } from "./state"

/*
 * prova 4, item 12: a Claude session closed with /exit, «Riprendi» showing, ran
 * `claude.exe --resume` at the next start, on the user's subscription; a session
 * that failed to start was retried at every start. A session that ended stays
 * ended until the user presses «Riprendi»; the ones alive when ADE closed come back.
 */
function pane(id: string, overrides: Partial<Pane> = {}): Pane {
  return {
    id,
    title: id,
    status: "working",
    activity: "working",
    model: "claude-code",
    mode: "auto",
    agent: "claude-code",
    resumeId: "5f0c3a52-0000-4000-8000-000000000001",
    lines: [],
    workspaceId: "ws",
    ...overrides,
  }
}

/** What the restart does: save, read back, restore, and ask both rounds which sessions start. */
function restart(panes: Pane[]) {
  const saved = parseWorkspace(serializeWorkspace(toWorkspaceState({ ...createWorkbench(), panes })))
  if (!saved) throw new Error("the saved state did not read back")
  const restored = fromWorkspaceState(saved)
  const planned = sessionsToResume(saved).map((p) => p.id)
  const second = liveToReopen(restored.panes, new Set(planned), saved).map((p) => p.id)
  return { planned, second, started: [...planned, ...second].sort() }
}

describe("a restart starts what was alive, not what had ended", () => {
  test("exit 0 («Riprendi» showing): not started", () => {
    expect(restart([pane("c1", { status: "done", activity: "done" })]).started).toEqual([])
  })

  test("exit 1 («Terminata (codice 1)»): not started", () => {
    expect(restart([pane("c2", { status: "error", activity: "exited" })]).started).toEqual([])
  })

  test("a failed start («Avvio fallito»): not retried", () => {
    expect(restart([pane("f5", { status: "error", activity: "startFailed", agent: "goose", model: "goose" })]).started).toEqual([])
  })

  test("alive when ADE closed, with a conversation: comes back by the first round", () => {
    const { planned, second } = restart([pane("live", { status: "working" })])
    expect(planned).toEqual(["live"])
    expect(second).toEqual([])
  })

  test("alive when ADE closed, with nothing to resume (a terminal): still comes back, by the second round", () => {
    const { planned, second } = restart([
      pane("term", { status: "idle", agent: "terminal", model: "terminal", resumeId: undefined, task: undefined }),
    ])
    expect(planned).toEqual([])
    expect(second).toEqual(["term"])
  })

  test("suspended stays suspended, and a mix keeps each one's own end", () => {
    const { started } = restart([
      pane("suspended", { status: "idle", suspended: true, activity: "suspended" }),
      pane("ended", { status: "done", activity: "done" }),
      pane("live", { status: "waiting" }),
      pane("term", { status: "working", agent: "terminal", model: "terminal", resumeId: undefined }),
    ])
    expect(started).toEqual(["live", "term"])
  })
})
