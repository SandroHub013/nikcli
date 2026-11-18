import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { codeOf } from "../test-support/source-text"
import { workbenchSource } from "../test-support/workbench-source"

/**
 * Handing a screenshot to the focused session from the viewer (UX-17).
 *
 * The workbench is too large to mount, so these read the source: what is pinned is the order of the steps and what the
 * function says about whether the text arrived, which a mounted test would have to rebuild the whole shell to see.
 */
const source = workbenchSource().replace(/\r\n/g, "\n")

function body(start: string, end: string): string {
  const at = source.indexOf(start)
  expect(at, `${start} is missing`).toBeGreaterThan(-1)
  return source.slice(at, source.indexOf(end, at))
}

describe("sendShotToFocused", () => {
  const send = body("const sendShotToFocused", "  /**\n   * Shows the user what a pane is waiting for")

  test("puts the caret back in the pane it typed into, before the viewer closes", () => {
    // The viewer is a Sheet that gives the focus back to whoever had it when it opened: the tile. A focus move that
    // happens while it is still open is recorded as the new opener, so Esc-less closing lands in the terminal.
    expect(send).toContain("focusPane(")
    expect(send).toContain("data-pane-id")
    expect(send.indexOf("typeAsUser(")).toBeLessThan(send.indexOf("focusPane("))
  })

  test("says it did not deliver when the text was held back", () => {
    // `typeAsUser` writes nothing over a question or while a dictation is held: closing the viewer on a `true` would
    // lose the picture without a word.
    expect(send).toMatch(/if \(!typeAsUser\(/)
    expect(send).toContain("return false")
    const typed = body("const typeAsUser", "  /**\n   * Gives a screenshot")
    expect(typed).toContain("return false")
    expect(typed).toContain("return true")
  })

  test("typeAsUser holds on composerNow === none but not on draft (MOD3-1)", () => {
    const typed = body("const typeAsUser", "  /**\n   * Gives a screenshot")
    expect(codeOf(typed)).toContain(
      codeOf(
        'if (dictationHold({ alive: true, questionOpen: questionOpen(paneId) }) || composerNow(paneId) === "none") {',
      ),
    )
    expect(codeOf(typed)).not.toContain("!mayType")
    expect(codeOf(typed)).not.toContain('"draft"')
  })

  test("typeAsUser tells note.textHeldByDialog when refocusedNow stands (F3 + F9)", () => {
    const typed = body("const typeAsUser", "  /**\n   * Gives a screenshot")
    expect(codeOf(typed)).toContain(
      codeOf(
        'hasTerminal(paneId) && refocusedNow(getTerminal(paneId).terminal) ? t("note.textHeldByDialog") : t("note.dictationHeld")',
      ),
    )
  })
})
