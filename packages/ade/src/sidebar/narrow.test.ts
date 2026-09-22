import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * What the sidebar does when it runs out of width.
 *
 * Both rules here were learned from the same defect and measured in ADE Test at
 * the column's 180px minimum: the footer row wanted 173px of the 164 available
 * and simply ran past the rounded edge, so the last reading was cut in half.
 * Read from the stylesheets, because neither is a value any module exports.
 */
const sidebar = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8")
const tray = readFileSync(new URL("../shots/tray.css", import.meta.url), "utf8")

/** A rule's declarations, with comments stripped so a note cannot pass for code. */
function ruleBody(css: string, selector: string): string {
  // Anchored to the start of a line, or a compound selector that merely ends
  // with this one would be mistaken for the rule itself.
  const start = css.indexOf(`
${selector} {`) + 1
  expect(start).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "")
}

describe("the sidebar footer, when the column is narrow", () => {
  test("the readings can shrink, so they never push past the edge", () => {
    const body = ruleBody(sidebar, '[data-slot="sidebar-stats"]')
    expect(body).not.toMatch(/flex:\s*0\s+0\s+auto/)
    expect(body).toContain("min-width: 0")
    expect(body).toContain("overflow: hidden")
  })

  /*
   * The form changes, the contents do not. Hiding the readings one at a time
   * left the processor alone at the 180px minimum, which the user read as a
   * truncated row: on a narrow column they take a second line instead, and all
   * three stay on screen.
   */
  test("on a narrow column the readings take a line of their own", () => {
    const narrow = sidebar.slice(sidebar.indexOf("@container (max-width: 184px)"))
    expect(narrow).not.toBe(sidebar)
    expect(narrow).toContain("flex-wrap: wrap")
    expect(narrow).toMatch(/\[data-slot="sidebar-stats"\] \{[^}]*flex: 1 0 100%/)
  })

  test("no reading is ever hidden to make the row fit", () => {
    for (const kind of ["cpu", "ram", "mem"]) {
      expect(sidebar).not.toMatch(new RegExp(`\[data-kind="${kind}"\] \{\s*display: none`))
    }
  })
})

describe("the screenshot tray", () => {
  test("is one row that scrolls sideways, not a block of rows", () => {
    const body = ruleBody(tray, '[data-slot="shot-tray-strip"]')
    expect(body).toContain("grid-auto-flow: column")
    expect(body).toMatch(/grid-template-rows:\s*\d+px/)
    expect(body).toContain("overflow-x: auto")
    // A ceiling on the height is what let it grow to three rows in the first place.
    expect(body).not.toContain("max-height")
    expect(body).not.toContain("grid-auto-rows")
  })

  /* Fixed columns rather than fractions, so a thumbnail is the same size at
     every sidebar width and one can hang over the edge. */
  test("its thumbnails are a fixed width, so one can hang over the edge", () => {
    expect(ruleBody(tray, '[data-slot="shot-tray-strip"]')).toMatch(/grid-auto-columns:\s*\d+px/)
  })

  /*
   * With the scrollbar hidden, the row has to say it continues and has to move
   * under a plain mouse wheel. Chromium turns a vertical wheel sideways only
   * when no ancestor can take it, and the sidebar can: measured in ADE Test,
   * three notches left scrollLeft at 0. Both halves of that are kept here.
   */
  test("it says it continues, on the edge that has more", () => {
    expect(tray).toContain('[data-slot="shot-tray-more"]')
    expect(ruleBody(tray, '[data-slot="shot-tray-row"]')).toContain("position: relative")
  })

  test("a vertical wheel is turned sideways by hand", () => {
    const tsx = readFileSync(new URL("../shots/tray.tsx", import.meta.url), "utf8")
    expect(tsx).toMatch(/onWheel/)
    expect(tsx).toMatch(/scrollLeft = before \+ event\.deltaY/)
  })
})
