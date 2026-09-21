import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * The sections box must not take the column's leftover height.
 *
 * Read from the stylesheet because this is a rule about layout, not about a
 * value any module exports: with `flex: 1` the box ran to the foot of the
 * sidebar, so a shut "File" section left half the column an empty card.
 */
const css = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8")

/** The declarations of one rule, with comments stripped so a note cannot pass for code. */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = css.indexOf("}", start)
  return css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "")
}

describe("the sidebar sections box", () => {
  test("is sized to its content, not to the column", () => {
    const body = ruleBody('[data-slot="sidebar-sections"]')
    expect(body).toContain("flex: 0 1 auto")
    expect(body).not.toMatch(/flex:\s*1\s*;/)
    expect(body).not.toMatch(/flex-grow:\s*[1-9]/)
  })

  test("can still shrink, so the scrolling section keeps working", () => {
    expect(ruleBody('[data-slot="sidebar-sections"]')).toContain("min-height: 0")
  })
})

/** Every rule written for this selector, in the order the browser reads them. */
function ruleBodies(selector: string): string[] {
  const bodies: string[] = []
  for (let at = css.indexOf(`${selector} {`); at >= 0; at = css.indexOf(`${selector} {`, at + 1)) {
    bodies.push(css.slice(at, css.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, ""))
  }
  expect(bodies.length).toBeGreaterThan(0)
  return bodies
}

/**
 * The screenshot tray sits at the foot of the column, and the sections do not
 * fill it. The two are one rule, and the file has already lost it once: the
 * sections box was `flex: 1`, which pushed the footer down as a side effect,
 * and the day that grow was removed — rightly, it was turning a shut "File"
 * into half a column of empty card — the tray came up with it and left the
 * leftover height underneath. So this fails in both directions: if nothing
 * holds the footer down, and if the footer is held down by giving the sections
 * the leftover back.
 */
describe("the screenshot tray", () => {
  test("is pushed to the foot of the column by the leftover height", () => {
    const margins = ruleBodies('[data-slot="sidebar-footer"]')
      .join("\n")
      .match(/margin-top:\s*([^;]+);/g)
    // The last declaration wins, so it is the one that decides where the tray sits.
    expect(margins?.at(-1)).toMatch(/margin-top:\s*auto\s*;/)
  })

  test("does not get there by letting the sections grow again", () => {
    for (const body of ruleBodies('[data-slot="sidebar-sections"]')) {
      expect(body).not.toMatch(/flex:\s*(1|auto|[1-9]\d*\s)/)
      expect(body).not.toMatch(/flex-grow:\s*[1-9]/)
    }
  })

  test("stays put whatever the sections do: no section takes the leftover either", () => {
    for (const body of ruleBodies('[data-slot="sidebar-section"]')) {
      expect(body).not.toMatch(/flex:\s*(1|auto|[1-9]\d*\s)/)
      expect(body).not.toMatch(/flex-grow:\s*[1-9]/)
    }
  })
})

/**
 * When space is constrained (e.g. short or narrow windows with "File" open),
 * the sections box must scroll rather than clip its children. Open sections
 * must remain scrollable, section headers must never be clipped, and no visible
 * scrollbars should appear.
 */
describe("sidebar section scrolling and scrollbars", () => {
  test("scrolls rather than clipping content when height runs short", () => {
    const body = ruleBody('[data-slot="sidebar-sections"]')
    expect(body).toContain("overflow-y: auto")
    expect(body).not.toMatch(/overflow:\s*hidden/)
    expect(body).not.toMatch(/overflow-y:\s*hidden/)
  })

  test("hides visible scrollbar on the sections container", () => {
    const body = ruleBody('[data-slot="sidebar-sections"]')
    expect(body).toContain("scrollbar-width: none")
  })

  test("every open section stays scrollable without showing a visible scrollbar", () => {
    const nonScrolls = ruleBodies('[data-slot="sidebar-section"][data-open]:not([data-scrolls]) [data-slot="section-content"]')
    for (const body of nonScrolls) {
      expect(body).toContain("overflow-y: auto")
      expect(body).toContain("scrollbar-width: none")
      expect(body).not.toMatch(/scrollbar-width:\s*thin/)
    }

    const scrolls = ruleBodies('[data-slot="sidebar-section"][data-scrolls] [data-slot="section-content"]')
    for (const body of scrolls) {
      expect(body).toContain("overflow-y: auto")
      expect(body).toContain("scrollbar-width: none")
      expect(body).not.toMatch(/scrollbar-width:\s*thin/)
    }
  })

  test("never clips section headers below their minimum content height", () => {
    const body = ruleBody('[data-slot="sidebar-section"]')
    expect(body).toContain("min-height: fit-content")
  })
})

