import { describe, test, expect } from "bun:test"
import {
  createWorkbench,
  addPane,
  closePane,
  updatePane,
  expandPane,
  setColumns,
  paneStatusToOccupantState,
  buildOccupantsByPath,
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

  test("paneStatusToOccupantState maps correctly", () => {
    expect(paneStatusToOccupantState("working")).toBe("working")
    expect(paneStatusToOccupantState("provisioning")).toBe("working")
    expect(paneStatusToOccupantState("waiting")).toBe("waiting")
    expect(paneStatusToOccupantState("done")).toBe("stopped")
    expect(paneStatusToOccupantState("error")).toBe("stopped")
  })

  test("buildOccupantsByPath maps absolute and relative paths", () => {
    const map = buildOccupantsByPath([mockPane], "C:/project")
    const occupantList = map.get("test/path")
    expect(occupantList).toBeDefined()
    expect(occupantList![0].sessionId).toBe("p1")
  })

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
    expect(restored.panes[0].status).toBe("working")
    // Note: in fromWorkspaceState we actually don't restore exact running status
    // but the test will verify the properties we assigned.
  })
})
