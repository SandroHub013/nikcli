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
