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

  test("lint: no reading is ever hidden to make the row fit", () => {
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
  test("lint: the tray has a more indicator on the row that scrolls, so it can say it continues", () => {
    expect(tray).toContain('[data-slot="shot-tray-more"]')
    expect(ruleBody(tray, '[data-slot="shot-tray-row"]')).toContain("position: relative")
  })

  test("lint: the tray turns a vertical wheel into sideways scroll by hand", () => {
    const tsx = readFileSync(new URL("../shots/tray.tsx", import.meta.url), "utf8")
    expect(tsx).toMatch(/onWheel/)
    expect(tsx).toMatch(/scrollLeft = before \+ event\.deltaY/)
  })
})

/*
 * fix-sidebar-nomi (0.8.0): at the user's width the projects read "C…" and the
 * active one only its badge, and the session cards "ni · feat/brows".
 * Measured in ADE Test at 200px: the names went from 38px (0 with a badge) to
 * 94px (34), the folder of a card keeps its name and the branch gets the "…".
 */
describe("the sidebar's names, when the column is narrow", () => {
  /** Every body of the rules whose selector is exactly `selector`, comments stripped. */
  function bodies(css: string, selector: string): string[] {
    const found: string[] = []
    let at = css.indexOf(`\n${selector} {`)
    while (at >= 0) {
      const open = css.indexOf("{", at)
      found.push(css.slice(open + 1, css.indexOf("}", open)).replace(/\/\*[\s\S]*?\*\//g, ""))
      at = css.indexOf(`\n${selector} {`, open)
    }
    return found
  }

  test("a project's name takes what the row has left", () => {
    const flex = bodies(sidebar, '[data-slot="workspace-name"]').flatMap((body) => body.match(/flex:[^;]+/g) ?? [])
    expect(flex.at(-1)).toBe("flex: 1 1 0")
  })

  test("the open-project button, seen only on hover, holds no room in the row", () => {
    const body = bodies(sidebar, '[data-slot="workspace-open-project"]')[0]!
    expect(body).toContain("position: absolute")
    expect(body).not.toContain("margin-right: auto")
  })

  test("lint: under 279px a project's count gives its right margin to the open-project button", () => {
    const narrow = sidebar.slice(sidebar.indexOf("@container ade-sidebar (max-width: 279px)"))
    expect(narrow).not.toBe(sidebar)
    expect(narrow).toMatch(/\[data-slot="workspace-count"\] \{[^}]*margin-right: calc\(18px/)
    expect(sidebar).toMatch(/aside\[data-component="ade-sidebar"\] \{[^}]*container: ade-sidebar \/ inline-size/)
  })

  test("a card's folder is not shrunk to two letters, and both names end in «…»", () => {
    const folder = bodies(sidebar, '[data-slot="agent-card-folder"]')[0]!
    const branch = bodies(sidebar, '[data-slot="agent-card-branch"]')[0]!
    expect(folder).toContain("flex: 0 0 auto")
    expect(folder).toMatch(/max-width: min\(120px, \d+%\)/)
    // `text-overflow` does not reach the text of a flex container.
    for (const body of [folder, branch]) {
      expect(body).toContain("display: block")
      expect(body).toContain("text-overflow: ellipsis")
    }
  })
})
