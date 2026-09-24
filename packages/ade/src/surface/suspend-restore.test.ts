import { describe, expect, test } from "bun:test"
import { parseWorkspace, serializeWorkspace } from "../session/persist"
import { resetLocaleForTests } from "../i18n"
import { createWorkbench, exitedToReopen, fromWorkspaceState, isResumable, sessionsToResume, toWorkspaceState, type Pane } from "./state"

/* A suspended session survives ADE's restart, and the restart does not wake it (P1-C6, point 5). */

function claude(overrides: Partial<Pane> = {}): Pane {
  return {
    id: "a",
    title: "A",
    status: "idle",
    activity: "suspended",
    model: "claude-code",
    mode: "auto",
    agent: "claude-code",
    resumeId: "5f0c3a52-0000-4000-8000-000000000001",
    lines: [{ kind: "note", text: "Sessione sospesa: processi chiusi, conversazione salvata. Riprendi per continuare." }],
    workspaceId: "ws",
    ...overrides,
  }
}

function saveAndRead(panes: Pane[]) {
  const workbench = { ...createWorkbench(), panes }
  const state = parseWorkspace(serializeWorkspace(toWorkspaceState(workbench)))
  if (!state) throw new Error("the saved state did not read back")
  return state
}

describe("the suspended mark across a restart", () => {
  test("saved and read back, still suspended, shown as Sospesa and not as to resume or finished", () => {
    resetLocaleForTests("it")
    const state = saveAndRead([claude({ suspended: true })])
    expect(state.panes[0]!.suspended).toBe(true)
    expect(state.panes[0]!.wasRunning).toBe(false)
    const pane = fromWorkspaceState(state).panes[0]!
    expect(pane.suspended).toBe(true)
    expect(pane.status).toBe("idle")
    expect(pane.activity).toBe("suspended")
    expect(pane.resumeId).toBe("5f0c3a52-0000-4000-8000-000000000001")
    // Its note is not followed by one saying the session is being reopened.
    expect(pane.lines.map((line) => line.text)).toEqual(["Sessione sospesa: processi chiusi, conversazione salvata. Riprendi per continuare."])
  })

  test("the sanitiser keeps true and drops anything else", () => {
    const text = (value: unknown) =>
      JSON.stringify({ version: 2, panes: [{ id: "a", title: "A", agent: "claude-code", cwd: "", branch: "", status: "idle", suspended: value }], sidebarWidth: 260, currentView: "code" })
    expect(parseWorkspace(text(true))!.panes[0]!.suspended).toBe(true)
    for (const value of ["true", 1, false, null, {}]) expect(parseWorkspace(text(value))!.panes[0]!.suspended).toBeUndefined()
  })

  test("a suspended pane is not resumable", () => {
    expect(isResumable(claude({ suspended: true }))).toBe(false)
    expect(isResumable(claude())).toBe(true)
  })
})

describe("the restore does not wake a suspended session", () => {
  test("not among the sessions to resume, even saved as running", () => {
    const state = saveAndRead([claude({ suspended: true }), claude({ id: "b" })])
    // As an older build could have saved it: running and suspended at once.
    state.panes[0]!.wasRunning = true
    expect(sessionsToResume(state).map((pane) => pane.id)).toEqual(["b"])
  })

  test("not reopened by the second round, while an exited session that is not suspended still is", () => {
    const panes = [claude({ suspended: true }), claude({ id: "gone", status: "done", activity: "done" }), claude({ id: "planned" })]
    expect(exitedToReopen(panes, new Set(["planned"])).map((pane) => pane.id)).toEqual(["gone"])
  })
})
