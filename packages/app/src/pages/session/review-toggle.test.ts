import { describe, expect, test } from "bun:test"
import { reviewToggleAction } from "./review-toggle"

/**
 * The panel that hosts review also hosts the file, context and browser tabs.
 * Treating the control as a panel switch meant asking for review could close
 * whatever else was open there and strand its tab.
 */

const OTHER_TABS = ["browser", "browser://localhost:3000", "context", "file://src/index.ts", "empty"]

describe("reviewToggleAction", () => {
  test("opens the panel when it is closed, whatever was last active", () => {
    for (const selectedTab of ["review", ...OTHER_TABS]) {
      expect(reviewToggleAction({ panelOpen: false, selectedTab })).toBe("open")
    }
  })

  test("closes only when review is what you are already looking at", () => {
    expect(reviewToggleAction({ panelOpen: true, selectedTab: "review" })).toBe("close")
  })

  test.each(OTHER_TABS)("switches to review rather than closing while %p is active", (selectedTab) => {
    expect(reviewToggleAction({ panelOpen: true, selectedTab })).toBe("activate")
  })

  test("never closes the panel out from under another tab", () => {
    for (const selectedTab of OTHER_TABS) {
      expect(reviewToggleAction({ panelOpen: true, selectedTab })).not.toBe("close")
    }
  })

  test("nothing selected yet is not review either, so the panel is not closed", () => {
    expect(reviewToggleAction({ panelOpen: true, selectedTab: undefined })).toBe("activate")
    expect(reviewToggleAction({ panelOpen: false, selectedTab: undefined })).toBe("open")
  })

  test("an unrecognised tab is not mistaken for review", () => {
    expect(reviewToggleAction({ panelOpen: true, selectedTab: "junk" })).toBe("activate")
  })

  test("pressing twice from review returns to review, not to nothing", () => {
    // close, then the panel is shut, so the next press opens it again
    expect(reviewToggleAction({ panelOpen: true, selectedTab: "review" })).toBe("close")
    expect(reviewToggleAction({ panelOpen: false, selectedTab: "review" })).toBe("open")
  })
})
