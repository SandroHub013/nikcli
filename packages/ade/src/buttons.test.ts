import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * One press, one transition, one focus ring — read from the stylesheets.
 *
 * These are rules about how the whole surface behaves, and no module exports
 * them, so the sheets themselves are the only honest place to check. The state
 * they describe was reached one sheet at a time: seven `:active` rules in the
 * whole app and none that moved anything, nine ways of drawing focus, and a
 * hover that snapped because its sheet had forgotten a transition. What this
 * file stops is the next one-off.
 */
const SRC = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

function sheets(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sheets(path))
    else if (entry.name.endsWith(".css")) found.push(path)
  }
  return found
}

/* Comments are stripped everywhere: these checks are about declarations, and a
   note explaining why a declaration is gone must not read as the declaration. */
const CSS = sheets(SRC).map((path) => ({
  path,
  text: readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
}))

/** A rule's declarations. */
function rules(text: string, selector: string): string[] {
  const bodies: string[] = []
  for (let at = text.indexOf(`${selector} {`); at >= 0; at = text.indexOf(`${selector} {`, at + 1)) {
    bodies.push(text.slice(at, text.indexOf("}", at)))
  }
  return bodies
}

describe("the button tokens", () => {
  const index = CSS.find((sheet) => sheet.path.endsWith("index.css"))!

  test("a press is one value, and movement can be turned off in one place", () => {
    expect(index.text).toContain("--ade-press: scale(0.97)")
    // Under reduced motion the ground still changes; only the geometry stops.
    const reduced = index.text.slice(index.text.indexOf("@media (prefers-reduced-motion: reduce)"))
    expect(reduced).toContain("--ade-press: none")
  })

  test("a button's transition is one recipe, and it carries the transform", () => {
    const recipe = index.text.slice(index.text.indexOf("--ade-btn-transition:"))
    expect(recipe).toContain("background var(--ade-dur-fast)")
    expect(recipe).toContain("transform var(--ade-dur-fast)")
  })

  /*
   * The glass theme is the one place hover and press darken instead of
   * lightening, and the reason is arithmetic rather than taste: chrome there
   * already carries a 6% white lift that leaves weak text at 4.51:1, so any
   * white wash on top takes it under the line — measured, 3.72:1 at 9%. A
   * white value here is a regression even when it looks fine on the desktop
   * whoever changed it happened to have open.
   */
  test("hover and press darken in the glass theme, because white is spent", () => {
    const glass = rules(index.text, ':root[data-theme="glass"]').join("\n")
    expect(glass).toContain("--ade-hover: rgba(0, 0, 0, 0.10)")
    expect(glass).toContain("--ade-active: rgba(0, 0, 0, 0.18)")
  })
})

describe("every sheet", () => {
  /*
   * `filter: brightness` was how the two badges in the top bar did their hover.
   * It lightens border, ground and text together — and on glass it lightens
   * whatever shows through the window — so the two loudest buttons in the app
   * were the two that behaved unlike everything else.
   */
  test("changes a button's ground on hover, never its brightness", () => {
    for (const { path, text } of CSS) {
      const hovers = text.split("\n").filter((line) => line.includes("filter: brightness"))
      expect({ path, hovers }).toEqual({ path, hovers: [] })
    }
  })

  /*
   * The ring is two rings — accent plus a softer glow — precisely so it stays
   * visible on top of an accent-filled button. A hand-rolled `outline` loses
   * that, and every one of them was a different width and offset.
   */
  test("draws keyboard focus with the ring, not with an outline of its own", () => {
    const rolled: string[] = []
    for (const { path, text } of CSS) {
      for (const [index, line] of text.split("\n").entries()) {
        if (!line.includes(":focus-visible")) continue
        const body = text.split("\n").slice(index, index + 8).join("\n")
        const declarations = body.slice(0, body.indexOf("}") + 1)
        const outline = declarations.match(/outline:\s*([^;]+);/)
        if (outline && !/^none$/.test(outline[1]!.trim())) rolled.push(`${path}: ${outline[1]!.trim()}`)
      }
    }
    expect(rolled).toEqual([])
  })

  test("extensions.css and keys.css use :focus-visible with the shared ring instead of :focus outline:none (polish B4)", () => {
    const ext = CSS.find((sheet) => sheet.path.endsWith("extensions.css"))!
    const keys = CSS.find((sheet) => sheet.path.endsWith("keys.css"))!

    // Neither should have :focus { outline: none }
    expect(ext.text).not.toMatch(/\[data-slot="ext-search"\]:focus\s*\{/)
    expect(keys.text).not.toMatch(/\[data-slot="keys-field"\]\s*input:focus\s*\{/)

    // Both should use :focus-visible with the shared ring
    expect(ext.text).toMatch(/\[data-slot="ext-search"\]:focus-visible\s*\{[^}]*box-shadow:\s*var\(--ade-focus-ring\)/)
    expect(keys.text).toMatch(/\[data-slot="keys-field"\]\s*input:focus-visible\s*\{[^}]*box-shadow:\s*var\(--ade-focus-ring\)/)
  })
})

describe("the button scale", () => {
  /*
   * Three sizes: 20 for chrome, 26 inside a panel, 32 for a confirm. The panes'
   * own header buttons are the documented exception — that row is 22px tall, so
   * its buttons are 18 and answer with the ground alone, since at that size the
   * three per cent of a press is half a pixel and reads as a flicker.
   */
  const SCALED: Record<string, number> = {
    '[data-slot="chat-send"]': 32,
    '[data-slot="new-launch-btn"]': 32,
    '[data-slot="bots-btn"]': 26,
    '[data-slot="settings-choice"]': 26,
    '[data-slot="decisions-badge"]': 26,
    '[data-slot="design-badge"]': 26,
  }

  for (const [selector, height] of Object.entries(SCALED)) {
    test(`${selector} is ${height}px, and says so once`, () => {
      const heights = CSS.flatMap(({ text }) => rules(text, selector))
        .flatMap((body) => body.match(/height:\s*(\d+)px/g) ?? [])
      expect(heights).toContain(`height: ${height}px`)
    })
  }
})
