import { describe, test, expect } from "bun:test"
import {
  createWorkbench,
  addPane,
  closePane,
  updatePane,
  expandPane,
  setColumns,
  deriveWorkspaces,
  toWorkspaceState,
  fromWorkspaceState,
  type Pane,
} from "./state"

describe("surface state", () => {
  const mockPane: Pane = {
    id: "p1",
    title: "Test",
    status: "working",
    model: "test-model",
    mode: "auto",
    lines: [],
    cwd: "test/path",
    workspaceId: "ws1",
  }

  test("addPane adds pane and focuses it", () => {
    let wb = createWorkbench()
    wb = addPane(wb, mockPane)
    expect(wb.panes).toHaveLength(1)
    expect(wb.panes[0]).toBe(mockPane)
    expect(wb.focusedId).toBe("p1")
  })

  test("closePane removes pane and updates focus", () => {
    let wb = createWorkbench()
    wb = addPane(wb, mockPane)
    wb = addPane(wb, { ...mockPane, id: "p2" })
    expect(wb.panes).toHaveLength(2)
    wb = closePane(wb, "p2")
    expect(wb.panes).toHaveLength(1)
    expect(wb.focusedId).toBe("p1")
  })

  test("updatePane modifies only the target pane", () => {
    let wb = createWorkbench()
    wb = addPane(wb, mockPane)
    wb = updatePane(wb, "p1", { title: "New Title" })
    expect(wb.panes[0].title).toBe("New Title")
  })

  /*
   * `paneStatusToOccupantState` and `buildOccupantsByPath` were tested here
   * and used nowhere else. They existed for the worktree board, which was
   * removed from the interface: the two functions, the `Occupant` model and
   * the whole `worktrees/` subsystem went with it. Their tests were the last
   * thing calling them, which is the shape this clean-up is about.
   */

  test("deriveWorkspaces groups panes", () => {
    const panes: Pane[] = [
      mockPane,
      { ...mockPane, id: "p2", workspaceId: "ws1" },
      { ...mockPane, id: "p3", workspaceId: "ws2" },
      { ...mockPane, id: "b1", browserUrl: "http://url", workspaceId: "ws3" }
    ]
    const ws = deriveWorkspaces(panes)
    expect(ws).toHaveLength(2) // browser is ignored
    expect(ws.find((w) => w.id === "ws1")?.sessions).toHaveLength(2)
    expect(ws.find((w) => w.id === "ws2")?.sessions).toHaveLength(1)
  })

  test("toWorkspaceState and fromWorkspaceState roundtrips basic info", () => {
    let wb = createWorkbench()
    wb = addPane(wb, mockPane)
    const state = toWorkspaceState(wb)
    expect(state.panes).toHaveLength(1)
    expect(state.panes[0].id).toBe("p1")
    
    const restored = fromWorkspaceState(state)
    expect(restored.panes).toHaveLength(1)
    expect(restored.panes[0].id).toBe("p1")
    /*
     * "done", not "working". The pane was saved mid-run, but a pty is a child
     * of the app: by the time this state is read back the process is gone,
     * whether the user closed the window or the machine restarted. Restoring
     * "working" showed a running session with no pid behind it, with the
     * liveness sweep animating under it. This test used to assert exactly
     * that, and its own comment noted the status was not really restored.
     */
    expect(restored.panes[0].status).toBe("done")
  })
})
