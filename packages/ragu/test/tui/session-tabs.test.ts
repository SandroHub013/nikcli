import { describe, expect, test } from "bun:test"
import { layoutSessionTabs, shouldShowSessionTabs, truncateTabTitle } from "@tui/component/session-tabs"

describe("session tab layout", () => {
  test("hides inside ADE", () => {
    const ade = { ADE_PANE_ID: "pane-1", ADE_MAILBOX: "C:/mail" }
    expect(shouldShowSessionTabs(1, ade)).toBe(false)
    expect(shouldShowSessionTabs(2, ade)).toBe(false)
  })

  test("hides a single session outside ADE and requires both ADE markers", () => {
    expect(shouldShowSessionTabs(1, {})).toBe(false)
    expect(shouldShowSessionTabs(2, {})).toBe(true)
    expect(shouldShowSessionTabs(2, { ADE_PANE_ID: "pane-1" })).toBe(true)
  })

  test("keeps all tabs visible when the terminal has room", () => {
    const result = layoutSessionTabs(["a", "b", "c"], "b", 100)

    expect(result.ids).toEqual(["a", "b", "c"])
    expect(result.hidden).toBe(0)
    expect(result.width).toBe(26)
  })

  test("keeps the active tab visible in a narrow terminal", () => {
    const result = layoutSessionTabs(["a", "b", "c", "d", "e"], "b", 50)

    expect(result.ids).toContain("b")
    expect(result.ids).toEqual(["b", "c"])
    expect(result.hidden).toBe(3)
    expect(result.width).toBe(12)
  })

  test("prioritizes the most recently opened tabs by default", () => {
    const result = layoutSessionTabs(["a", "b", "c", "d"], undefined, 40)

    expect(result.ids).toEqual(["d"])
    expect(result.hidden).toBe(3)
  })

  test("spends no horizontal cells on the close-all button", () => {
    // `+ new` and `× all` are stacked in one 8-wide column.
    const LOGO = 9
    const BUTTON = 8
    const [gaps, count] = [2, 3]

    expect(layoutSessionTabs(["a", "b", "c"], "b", 100).width).toBe(
      Math.floor((100 - LOGO - BUTTON - gaps) / count) - 1,
    )
  })

  test("normalizes and truncates long titles", () => {
    expect(truncateTabTitle("  Search\n scrollback   bottom bar  ", 18)).toBe("Search scrollback…")
    expect(truncateTabTitle("   ", 20)).toBe("Untitled session")
    expect(Bun.stringWidth(truncateTabTitle("Design 🎨 session tabs", 12))).toBeLessThanOrEqual(12)
  })
})
