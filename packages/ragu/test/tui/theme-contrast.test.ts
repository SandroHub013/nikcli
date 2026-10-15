import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { BUILT_IN_THEME_IDS, loadBuiltInTheme } from "@tui/context/theme-catalog"
import { contrastFg, createStandaloneTheme, type Theme } from "@tui/context/theme"
import { deriveSemanticTokens, type TokenSource } from "@tui/context/theme-tokens"

/**
 * Every built-in theme, in both modes, measured on the colour pairs the screens draw.
 *
 * The pairs and the floors are the ones of the "triple A" review (phase A §2): body text has to reach 7:1, secondary
 * and coloured text 4.5:1, code 4.5:1 on each background it is drawn on, and the marks that are not text 3:1. Each
 * pair names where the screen draws it, so a failure says what a person cannot read.
 *
 * The contrast is WCAG 2.x, written out here rather than imported: the engine is what is being measured, so it cannot
 * also be the ruler.
 */

type Role = "text" | "secondary" | "colour" | "syntax" | "graphic"
const MIN: Record<Role, number> = { text: 7, secondary: 4.5, colour: 4.5, syntax: 4.5, graphic: 3 }

/** What a transparent theme background shows through to: a dark terminal, or a white one. */
const TERMINAL = { dark: RGBA.fromHex("#0c0c0c"), light: RGBA.fromHex("#ffffff") }

const channel = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = (c: RGBA) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
function ratio(fg: RGBA, bg: RGBA): number {
  const [a, b] = [luminance(fg), luminance(bg)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
/** A colour with alpha laid over an opaque one, as the renderer blends it. */
function over(fg: RGBA, bg: RGBA): RGBA {
  const mix = (f: number, b: number) => f * fg.a + b * (1 - fg.a)
  return RGBA.fromValues(mix(fg.r, bg.r), mix(fg.g, bg.g), mix(fg.b, bg.b), 1)
}

type Pair = { id: string; role: Role; where: string; fg: RGBA; bg: RGBA }

/** The pairs, in the engine's own tokens: what `useTheme()` hands the components. */
function pairs(t: Theme, reasoning: RGBA): Pair[] {
  const out: Pair[] = []
  const add = (id: string, role: Role, where: string, fg: RGBA, bg: RGBA) => out.push({ id, role, where, fg, bg })
  const { base, panel, offset, overlay } = t.surface
  add("text/base", "text", "transcript", t.foreground.default, base)
  add("text/panel", "text", "user message, errors, tabs", t.foreground.default, panel)
  add("text/offset", "text", "prompt", t.foreground.default, offset)
  add("text/overlay", "text", "dialogs and menus", t.foreground.default, overlay)
  add("markdown.text/base", "text", "markdown answer", t.markdown.text, base)
  add("markdown.heading/base", "text", "markdown headings", t.markdown.heading, base)
  add("markdown.strong/base", "text", "markdown bold", t.markdown.strong, base)
  add("markdown.codeBlock/base", "text", "code block", t.markdown.codeBlock, base)
  add("selection/badge", "text", "selected row, primary button", t.badge.fg, t.badge.bg)
  add("diff.text/added", "text", "added line", t.foreground.default, t.diff.addedBg)
  add("diff.text/removed", "text", "removed line", t.foreground.default, t.diff.removedBg)
  add("diff.text/context", "text", "context line", t.foreground.default, t.diff.contextBg)

  add("muted/base", "secondary", "hints, times, details", t.foreground.muted, base)
  add("muted/panel", "secondary", "details on the user message, errors", t.foreground.muted, panel)
  add("muted/offset", "secondary", "prompt placeholder", t.foreground.muted, offset)
  add("muted/overlay", "secondary", "descriptions in dialogs", t.foreground.muted, overlay)
  add("subtle/base", "secondary", "tool markers, «▸ N more lines»", t.foreground.subtle, base)
  add("reasoning/base", "secondary", "reasoning text", reasoning, base)
  add("diff.number/context", "secondary", "line numbers", t.diff.lineNumber, t.diff.contextBg)
  add("diff.number/added", "secondary", "line numbers of additions", t.diff.lineNumber, t.diff.addedLineNumberBg)
  add("diff.number/removed", "secondary", "line numbers of removals", t.diff.lineNumber, t.diff.removedLineNumberBg)

  add("accent/base", "colour", "primary accent as text", t.accent.fg, base)
  add("accent.alt/base", "colour", "second accent", t.accent.alt, base)
  add("secondary/base", "colour", "agents, attachments", t.accent.secondary, base)
  for (const k of ["error", "warning", "success", "info"] as const) {
    add(`${k}/base`, "colour", `${k} as text`, t.status[k].fg, base)
    add(`${k}/panel`, "colour", `${k} on a panel`, t.status[k].fg, panel)
  }
  for (const k of ["link", "linkText", "code", "blockQuote", "emph", "listItem", "listEnumeration"] as const)
    add(`markdown.${k}/base`, "colour", "markdown", t.markdown[k], base)
  add("diff.sign+/added", "colour", "+ sign of the diff", t.diff.highlightAdded, t.diff.addedBg)
  add("diff.sign-/removed", "colour", "- sign of the diff", t.diff.highlightRemoved, t.diff.removedBg)

  for (const k of Object.keys(t.syntax) as (keyof Theme["syntax"])[]) {
    add(`syntax.${k}/base`, "syntax", "code", t.syntax[k], base)
    add(`syntax.${k}/added`, "syntax", "code on an added line", t.syntax[k], t.diff.addedBg)
    add(`syntax.${k}/removed`, "syntax", "code on a removed line", t.syntax[k], t.diff.removedBg)
  }

  add("border.active/base", "graphic", "active border", t.border.active, base)
  add("focus/base", "graphic", "focus ring", t.border.focus, base)
  add("selection.bar/overlay", "graphic", "selection bar in dialogs", t.badge.bg, overlay)
  add("accent.bar/panel", "graphic", "active tab border", t.accent.fg, panel)
  return out
}

type Measured = { theme: string; mode: "dark" | "light"; id: string; where: string; ratio: number; min: number }

async function measure(id: string, mode: "dark" | "light"): Promise<Measured[]> {
  return measureDocument(id, await loadBuiltInTheme(id), mode)
}

function measureDocument(id: string, document: unknown, mode: "dark" | "light"): Measured[] {
  const standalone = createStandaloneTheme({ document, mode })
  const t = standalone.theme
  const reasoning = standalone.subtleSyntax().getStyle("default")?.fg ?? t.foreground.default
  const terminal = TERMINAL[mode]
  const base = over(t.surface.base, terminal)
  return pairs(t, reasoning).map((p) => {
    const bg = over(over(p.bg, base), terminal)
    return { theme: id, mode, id: p.id, where: p.where, ratio: ratio(over(p.fg, bg), bg), min: MIN[p.role] }
  })
}

/**
 * Pairs no change of lightness can close, each with the reason; `script/fix-themes.ts` lists them when it runs.
 * Kept honest both ways: a pair that starts passing has to leave this list.
 */
const KNOWN: Record<string, string> = {}

const key = (m: Measured) => `${m.theme}/${m.mode} ${m.id}`
const describeFailure = (m: Measured) => `${key(m)}: ${m.ratio.toFixed(2)} < ${m.min} (${m.where})`

describe("theme contrast", () => {
  test("measures the whole catalog", () => {
    expect(BUILT_IN_THEME_IDS.length).toBeGreaterThan(100)
  })

  for (const mode of ["dark", "light"] as const) {
    test(`every pair of every built-in theme reaches its floor in ${mode} mode`, async () => {
      const measured = (await Promise.all(BUILT_IN_THEME_IDS.map((id) => measure(id, mode)))).flat()
      expect(measured.length).toBeGreaterThan(BUILT_IN_THEME_IDS.length * 60)
      const failing = measured.filter((m) => m.ratio < m.min)
      expect(failing.filter((m) => !(key(m) in KNOWN)).map(describeFailure)).toEqual([])
      const known = Object.keys(KNOWN).filter((k) => k.split(" ")[0]!.endsWith(`/${mode}`))
      expect(known.filter((k) => !failing.some((m) => key(m) === k))).toEqual([])
    })
  }
})

describe("the colours the engine derives", () => {
  const rgb = (hex: string) => RGBA.fromHex(hex)
  const source = (overrides: Partial<TokenSource>): TokenSource => {
    // Every colour the test does not name is mid grey: what matters is the one it does.
    const grey = rgb("#808080")
    return new Proxy({} as TokenSource, {
      get: (_target, prop: string) => (prop in overrides ? overrides[prop as keyof TokenSource] : grey),
    })
  }
  const derive = (overrides: Partial<TokenSource>, hasSelectedListItemText = false) =>
    deriveSemanticTokens(source(overrides), { hasSelectedListItemText, thinkingOpacity: 0.6, mode: "dark" })

  test("text on a fill is black or white by the WCAG ratio: black on pure red, where BT.601 chose white", () => {
    expect(contrastFg(rgb("#ff0000"))).toEqual(rgb("#000000"))
    expect(contrastFg(rgb("#0000ff"))).toEqual(rgb("#ffffff"))
    for (const hex of ["#ff0000", "#00a000", "#3a96dd", "#c19c00", "#808080", "#f39a6b"])
      expect(ratio(contrastFg(rgb(hex)), rgb(hex))).toBeGreaterThanOrEqual(4.5)
  })

  test("subtle is muted faded toward the background, but never under 4.5:1 on it", () => {
    const background = rgb("#121212")
    for (const muted of ["#9a9a9a", "#808080", "#5a5a5a", "#2a2a2a"]) {
      const subtle = derive({ background, textMuted: rgb(muted) }).foreground.subtle
      expect(ratio(subtle, background)).toBeGreaterThanOrEqual(4.5)
    }
    // A muted with room to spare keeps the old 40 % fade.
    const roomy = derive({ background, textMuted: rgb("#e0e0e0") }).foreground.subtle
    expect(ratio(roomy, background)).toBeLessThan(ratio(rgb("#e0e0e0"), background))
  })

  test("the selected row reaches 7:1: when no text does on primary, the fill moves", () => {
    for (const primary of ["#3a96dd", "#808080", "#e45649", "#6fa3ff"]) {
      const badge = derive({ primary: rgb(primary) }).badge
      expect(ratio(badge.fg, badge.bg)).toBeGreaterThanOrEqual(7)
    }
    const declared = derive({ primary: rgb("#3a96dd"), selectedListItemText: rgb("#ffffff") }, true).badge
    expect(declared.fg).toEqual(rgb("#ffffff"))
    expect(ratio(declared.fg, declared.bg)).toBeGreaterThanOrEqual(7)
  })
})
