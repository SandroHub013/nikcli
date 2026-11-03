import { describe, expect, test } from "bun:test"
import { NEW_PANE_ITEMS, showsAllForNewPane } from "./new-pane"
import { createWorkbench, type Pane } from "./state"

/*
 * prova 4, item 13: «Nuovo pannello» with a maximised pane opened the new pane
 * behind it, and nothing seemed to happen, so people opened it twice. A command
 * of the menu now un-maximises first, so the new pane is in the grid, in view.
 */
const pane = (id: string): Pane => ({
  id,
  title: id,
  status: "working",
  model: "claude-code",
  mode: "auto",
  lines: [],
  workspaceId: "ws",
})

describe("«Nuovo pannello» with a maximised pane", () => {
  const maximised = { ...createWorkbench(), panes: [pane("a"), pane("b")], focusedId: "a", expandedId: "a" }

  test("every entry of the menu brings the grid back, so the new pane is not hidden behind the maximised one", () => {
    for (const item of NEW_PANE_ITEMS) {
      const next = showsAllForNewPane(maximised, item.commandId)
      expect(next.expandedId).toBeUndefined()
      // Nothing else changes: the panes, the focus.
      expect(next.panes).toEqual(maximised.panes)
      expect(next.focusedId).toBe("a")
    }
  })

  test("another command leaves a maximised pane as it is", () => {
    expect(showsAllForNewPane(maximised, "theme.toggle")).toBe(maximised)
  })

  test("nothing maximised: the same workbench back", () => {
    const grid = { ...maximised, expandedId: undefined }
    expect(showsAllForNewPane(grid, "decisions.pane")).toBe(grid)
  })
})
