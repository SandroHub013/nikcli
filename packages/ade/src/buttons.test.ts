import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import postcss, { type Rule } from "postcss"

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
    // 0.10 or 0.1, which is how prettier writes it.
    expect(glass).toMatch(/--ade-hover: rgba\(0, 0, 0, 0\.10?\)/)
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
        const body = text
          .split("\n")
          .slice(index, index + 8)
          .join("\n")
        const declarations = body.slice(0, body.indexOf("}") + 1)
        const outline = declarations.match(/outline:\s*([^;]+);/)
        // `none` is a sheet taking its own focus off; the transparent outline and the forced-colours `Highlight` one
        // are the contrast-theme fallback (UX-19), which paints nothing in the normal themes.
        if (outline && !/^(none|2px solid transparent|2px solid Highlight !important)$/.test(outline[1]!.trim()))
          rolled.push(`${path}: ${outline[1]!.trim()}`)
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
    expect(keys.text).toMatch(
      /\[data-slot="keys-field"\]\s*input:focus-visible\s*\{[^}]*box-shadow:\s*var\(--ade-focus-ring\)/,
    )
  })

  test("uses --ade-radius-full instead of 999px, token radii instead of 6px, and tokens for B2 spacings (polish B2)", () => {
    for (const { path, text } of CSS) {
      const lines = text.split("\n")
      const raw999 = lines.filter((l) => /border(-[a-z]+)*-radius:\s*999px\b/.test(l))
      const raw6px = lines.filter((l) => /border(-[a-z]+)*-radius:\s*6px\b/.test(l))
      expect({ path, raw999 }).toEqual({ path, raw999: [] })
      expect({ path, raw6px }).toEqual({ path, raw6px: [] })
    }

    const decisions = CSS.find((sheet) => sheet.path.endsWith("decisions.css"))!
    expect(decisions.text).not.toContain("7px 9px")
    expect(decisions.text).not.toContain("7px 10px")

    const sidebar = CSS.find((sheet) => sheet.path.endsWith("sidebar.css"))!
    expect(sidebar.text).not.toContain("5px 10px")
    expect(sidebar.text).not.toContain("7px 11px")
    expect(sidebar.text).not.toMatch(/gap:\s*7px\b/)

    const pane = CSS.find((sheet) => sheet.path.endsWith("pane.css"))!
    expect(pane.text).not.toContain("padding: 0 8px 0 5px")
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
    '[data-slot="settings-choice"]': 26,
    '[data-slot="bar-queue"]': 26,
  }

  for (const [selector, height] of Object.entries(SCALED)) {
    test(`${selector} is ${height}px, and says so once`, () => {
      const heights = CSS.flatMap(({ text }) => rules(text, selector)).flatMap(
        (body) => body.match(/height:\s*(\d+)px/g) ?? [],
      )
      expect(heights).toContain(`height: ${height}px`)
    })
  }
})

describe("a primary-coloured control is the primitive's", () => {
  /*
   * DS-8: eight sheets redrew the accent-filled button, each with its own height, radius and disabled opacity. The
   * primitive (`ui/controls.css`, `[data-ui="button"]`) owns that look now, so a rule that fills something with the
   * accent ground is either the primitive, or a thing that is not a button (a bar, a dot, a selection), or one of
   * the existing ones named here.
   *
   * The list is a ratchet: it only gets shorter. A new accent-filled button does not go on it — it is a
   * `<Button variant="primary">`. A rule that leaves the list must be taken off it, so the next one cannot hide
   * behind its name.
   */
  const ACCENT_GROUND = /^var\(--ade-accent(-strong)?\)$/
  const BASELINE: readonly string[] = [
    "agent/agent-console.css :: [data-slot=\"agent-action\"][data-primary]",
    "agent/agent-console.css :: [data-slot=\"agent-action\"][data-primary]:hover",
    "agent/agent-console.css :: [data-slot=\"agent-send\"]",
    "agent/agent-console.css :: [data-slot=\"agent-send\"]:hover:not(:disabled)",
    "bots/bots.css :: [data-slot=\"bots-row-unread\"]",
    "bots/bots.css :: [data-slot=\"room-needs-you\"]",
    "browser/browser.css :: [data-slot=\"dev-server-offer-open\"]",
    "chat/chat.css :: [data-slot=\"chat-caret\"]",
    "command/palette.css :: [data-component=\"palette\"] [data-slot=\"option\"][data-selected]::before",
    "decisions/decisions.css :: [data-slot=\"decision-option\"][data-on] [data-slot=\"decision-option-key\"]",
    "design/design.css :: [data-slot=\"variant-pick-button\"][data-on=\"true\"] [data-slot=\"variant-key\"]",
    "dev.css :: [data-slot=\"ade-add\"][data-tone=\"primary\"]",
    "dev.css :: [data-slot=\"ade-add\"][data-tone=\"primary\"]:hover",
    "dev.css :: [data-slot=\"ade-notice-progress-fill\"]",
    "editor/editor.css :: [data-component=\"editor\"] [data-slot=\"btn\"][data-variant=\"primary\"]",
    "editor/editor.css :: [data-component=\"editor\"] [data-slot=\"btn\"][data-variant=\"primary\"]:hover:not(:disabled)",
    "grid/pane.css :: [data-slot=\"pane-answer\"][data-tone=\"primary\"]",
    "grid/pane.css :: [data-slot=\"pane-answer\"][data-tone=\"primary\"]:hover",
    "index.css :: [data-component=\"update-dialog\"] [data-slot=\"update-dialog-fill\"]",
    "index.css :: [data-slot=\"sidebar-resize-handle\"]:hover, [data-component=\"ade-sidebar\"][data-resizing] [data-slot=\"sidebar-resize-handle\"]",
    "remote/remote.css :: [data-component=\"remote-space\"] [data-slot=\"primary\"]",
    "review/diff-view.css :: [data-component=\"diff-view\"] [data-slot=\"file-row\"][data-selected]::before",
    "review/diff-view.css :: [data-component=\"diff-view\"] [data-slot=\"status\"][data-status=\"modified\"]",
    "review/diff-view.css :: [data-component=\"diff-view\"] [data-slot=\"status\"][data-status=\"renamed\"]",
    "session-new/session-new.css :: [data-slot=\"new-count\"][data-active]",
  ]

  test("no new rule fills a control with the accent ground", () => {
    const found: string[] = []
    for (const { path, text } of CSS) {
      const file = path.slice(SRC.length).split("\\").join("/").replace(/^\//, "")
      for (const rule of postcss.parse(text).nodes.flatMap((node) =>
        node.type === "rule" ? [node] : node.type === "atrule" && node.name !== "keyframes" ? (node.nodes ?? []).filter((n) => n.type === "rule") : [],
      )) {
        const fills = (rule as Rule).nodes.some(
          (decl) => decl.type === "decl" && /^background(-color)?$/.test(decl.prop) && ACCENT_GROUND.test(decl.value.trim()),
        )
        if (fills) found.push(`${file} :: ${(rule as Rule).selector.replace(/\s+/g, " ")}`)
      }
    }
    found.sort()
    expect(found.filter((entry) => !BASELINE.includes(entry))).toEqual([])
    // A rule that was cleaned up must also leave the list, or the list stops being a ratchet.
    expect(BASELINE.filter((entry) => !found.includes(entry))).toEqual([])
  })
})
