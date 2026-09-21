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
  const start = css.indexOf(`${selector} {`)
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
   * Which one leaves is a decision, not an accident of source order: a reading
   * can also be found in the panel, a button is the only way to reach what it
   * opens. So the readings go, one at a time, and the buttons never move.
   */
  test("a reading leaves at each measured width, and the buttons stay", () => {
    expect(sidebar).toMatch(/@container \(max-width: 215px\) \{\s*\[data-slot="sidebar-stat"\]\[data-kind="mem"\] \{\s*display: none/)
    expect(sidebar).toMatch(/@container \(max-width: 192px\) \{\s*\[data-slot="sidebar-stat"\]\[data-kind="ram"\] \{\s*display: none/)
    for (const kind of ["cpu"]) {
      expect(sidebar).not.toContain(`[data-kind="${kind}"] {\n    display: none`)
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

  /*
   * Fixed columns rather than fractions: a thumbnail is then the same size at
   * every sidebar width, and the one that does not fit shows a sliver of itself
   * — which is the only thing saying the row continues, with the scrollbar
   * hidden and no second line to fall onto.
   */
  test("its thumbnails are a fixed width, so one can hang over the edge", () => {
    expect(ruleBody(tray, '[data-slot="shot-tray-strip"]')).toMatch(/grid-auto-columns:\s*\d+px/)
  })
})
