import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * Target size (WCAG 2.5.8) and non-text contrast (1.4.11) in the sheets: UX-18 and UX-19 of the 2026-11-02 audit.
 *
 * A pointer target under 24px, or a control whose only edge is the 1.3:1 separator ramp, does not announce itself
 * as an error: it looks fine on the desk of whoever drew it. These read the sheets for the specific controls the
 * audit named, so the next change that shrinks one is noticed.
 */
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `${selector} is missing`).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf("}", at))
}

/** A declared size in px, or the value of the token it names. */
function px(declarations: string, property: "width" | "height"): number {
  const match = declarations.match(new RegExp(`(?:^|\\n)\\s*${property}:\\s*(\\d+)px`))
  expect(match, `${property} in px`).not.toBeNull()
  return Number(match![1])
}

describe("targets of at least 24px (UX-18)", () => {
  test("the sidebar's footer icons keep 24px when the column is narrow", () => {
    const sidebar = read("./sidebar/sidebar.css")
    const narrow = sidebar.slice(sidebar.indexOf("@container (max-width: 230px)"))
    const body = rule(narrow, '[data-slot="sidebar-settings"],\n  [data-slot="sidebar-footer-actions"] [data-slot="ade-icon"]')
    expect(px(body, "width")).toBeGreaterThanOrEqual(24)
    expect(px(body, "height")).toBeGreaterThanOrEqual(24)
  })

  test("a small icon button, and the screenshot dismiss, reach 24px with their hit area", () => {
    const controls = read("./ui/controls.css")
    // 20px glyph box + 2px on every side.
    expect(controls).toMatch(/\[data-ui="icon-button"\]\[data-size="sm"\]\)::before \{[^}]*inset: -2px/)
    const tray = read("./shots/tray.css")
    // 18px circle + 3px on every side.
    expect(px(rule(tray, '[data-slot="shot-dismiss"]'), "width")).toBe(18)
    expect(tray).toMatch(/\[data-slot="shot-dismiss"\]::before \{[^}]*inset: -3px/)
  })
})

describe("the pane header and composer (UX-18, UX-19)", () => {
  const pane = read("./grid/pane.css")

  test("the header's action buttons reach 24px by their hit area", () => {
    // 18px buttons with 3px on every side; the session pane's 20px ones with 2px, so neighbours do not overlap.
    expect(px(rule(pane, '[data-slot="pane-action"]'), "width") + 6).toBeGreaterThanOrEqual(24)
    expect(rule(pane, '[data-slot="pane-action"]::before')).toContain("inset: -3px")
    expect(px(rule(pane, '[data-component="session-pane"] [data-slot="pane-action"]'), "width") + 4).toBeGreaterThanOrEqual(24)
    expect(rule(pane, '[data-component="session-pane"] [data-slot="pane-action"]::before')).toContain("inset: -2px")
    expect(px(rule(pane, ".hA .act"), "width") + 4).toBeGreaterThanOrEqual(24)
    expect(rule(pane, ".hA .act::before")).toContain("inset: -2px")
  })

  test("the composer shows its focus with a ring, not with a ground that moves by 1.1:1", () => {
    const body = rule(pane, '[data-slot="pane-prompt"]:focus-within')
    expect(body).toContain("box-shadow: inset 0 0 0 2px var(--ade-text-weak)")
    expect(body).toContain("outline: 2px solid transparent")
  })
})

describe("focus and edges you can see (UX-19)", () => {
  test("the decision note's edge is the control border, and its focus is the ring", () => {
    const decisions = read("./decisions/decisions.css")
    expect(rule(decisions, '[data-slot="decision-note"]')).toContain("border: 1px solid var(--ade-control-border)")
    // Not a lone border change: the `:focus` rule that took the outline off is gone.
    expect(decisions).not.toContain('[data-slot="decision-note"]:focus {')
    expect(rule(decisions, '[data-slot="decision-note"]:focus-visible')).not.toContain("outline: none")
  })

  test("the global focus keeps an outline, so a contrast theme that removes shadows still shows it", () => {
    const index = read("./index.css")
    expect(rule(index, "\n:focus-visible")).toContain("outline: 2px solid transparent")
    expect(index).toMatch(/@media \(forced-colors: active\) \{\s*:focus-visible \{[^}]*outline: 2px solid Highlight !important/)
  })
})
