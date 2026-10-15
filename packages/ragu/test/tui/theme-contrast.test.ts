import { describe, expect, test } from "bun:test"
import { RGBA, type TerminalColors } from "@opentui/core"
import { BUILT_IN_THEME_IDS, loadBuiltInTheme } from "@tui/context/theme-catalog"
import { contrastFg, createStandaloneTheme, generateSystem, type Theme } from "@tui/context/theme"
import { deriveSemanticTokens, type TokenSource } from "@tui/context/theme-tokens"
import { toOklch } from "@tui/context/contrast"

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

type Role = "text" | "secondary" | "colour" | "syntax" | "graphic" | "decoration"
/** Decoration, the plain borders, has no floor: those pairs are there for the comparison with greyscale. */
const MIN: Record<Role, number> = { text: 7, secondary: 4.5, colour: 4.5, syntax: 4.5, graphic: 3, decoration: 1 }

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

  // Accents and states are text on every surface: the transcript, the panels, the prompt's line («Build ·
  // Custom»), the dialogs (their categories).
  const surfaces = { base, panel, offset, overlay }
  for (const [name, bg] of Object.entries(surfaces)) {
    add(`accent/${name}`, "colour", "primary accent as text", t.accent.fg, bg)
    add(`accent.alt/${name}`, "colour", "second accent", t.accent.alt, bg)
    add(`secondary/${name}`, "colour", "agents, attachments, the permission mode", t.accent.secondary, bg)
    for (const k of ["error", "warning", "success", "info"] as const)
      add(`${k}/${name}`, "colour", `${k} as text`, t.status[k].fg, bg)
  }
  // The error and warning toasts sit on their state's fill: its icon, title and message.
  for (const k of ["error", "warning"] as const) {
    add(`${k}/own-fill`, "colour", `${k} toast icon`, t.status[k].fg, t.status[k].bg)
    add(`text/${k}-fill`, "text", `${k} toast message`, t.foreground.default, t.status[k].bg)
    add(`muted/${k}-fill`, "secondary", `${k} toast detail`, t.foreground.muted, t.status[k].bg)
  }
  for (const k of ["link", "linkText", "code", "blockQuote", "emph", "listItem", "listEnumeration"] as const)
    add(`markdown.${k}/base`, "colour", "markdown", t.markdown[k], base)
  // The renderer draws the signs in the gutter, on the line-number fill of their line (phase A measured them on
  // the line's own fill).
  add("diff.sign+/added", "colour", "+ sign of the diff", t.diff.highlightAdded, t.diff.addedLineNumberBg)
  add("diff.sign-/removed", "colour", "- sign of the diff", t.diff.highlightRemoved, t.diff.removedLineNumberBg)

  for (const k of Object.keys(t.syntax) as (keyof Theme["syntax"])[]) {
    add(`syntax.${k}/base`, "syntax", "code", t.syntax[k], base)
    add(`syntax.${k}/added`, "syntax", "code on an added line", t.syntax[k], t.diff.addedBg)
    add(`syntax.${k}/removed`, "syntax", "code on a removed line", t.syntax[k], t.diff.removedBg)
  }
  // The states the highlighter also paints code in: builtins and tags (error), annotations (warning), notes (info).
  for (const k of ["error", "warning", "info"] as const) {
    add(`syntax.${k}/added`, "syntax", "code on an added line", t.status[k].fg, t.diff.addedBg)
    add(`syntax.${k}/removed`, "syntax", "code on a removed line", t.status[k].fg, t.diff.removedBg)
  }

  add("border.active/base", "graphic", "active border", t.border.active, base)
  add("focus/base", "graphic", "focus ring", t.border.focus, base)
  add("selection.bar/overlay", "graphic", "selection bar in dialogs", t.badge.bg, overlay)
  add("accent.bar/panel", "graphic", "active tab border", t.accent.fg, panel)
  add("border/base", "decoration", "borders", t.border.default, base)
  add("border/overlay", "decoration", "borders in dialogs", t.border.default, overlay)
  add("border.subtle/base", "decoration", "separators", t.border.subtle, base)
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
 * Pairs no change of lightness can close, each with the reason; `script/fix-themes.ts` lists them when it runs. A key
 * with no pair after the variant («github-light/light») stands for every pair of it. Kept honest both ways: a pair
 * that starts passing has to leave this list.
 */
const ZENBURN =
  "zenburn's surfaces are mid greys (#3f3f3f to #5f5f5f): no text colour reaches 7:1 on the lightest, the best is 6.4"
const KNOWN: Record<string, string> = {
  "zenburn/dark text/panel": ZENBURN,
  "zenburn/dark text/offset": ZENBURN,
  "zenburn/dark text/overlay": ZENBURN,
  "zenburn/dark diff.text/added": ZENBURN,
  "zenburn/dark diff.text/removed": ZENBURN,
  "zenburn/dark diff.text/context": ZENBURN,
  "github-light/light":
    "its backgroundElement, under the prompt and the dialogs, is the `selection` def, solid #0366d6 blue: no colour " +
    "reads on it and on the light grey surfaces both, so the text, muted and every accent are left as they were",
}

const key = (m: Measured) => `${m.theme}/${m.mode} ${m.id}`
const known = (m: Measured) => key(m) in KNOWN || `${m.theme}/${m.mode}` in KNOWN
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
      expect(failing.filter((m) => !known(m)).map(describeFailure)).toEqual([])
      const listed = Object.keys(KNOWN).filter((k) => k.split(" ")[0]!.endsWith(`/${mode}`))
      const stillFailing = (k: string) => failing.some((m) => key(m) === k || `${m.theme}/${m.mode}` === k)
      expect(listed.filter((k) => !stillFailing(k))).toEqual([])
    })
  }
})

/**
 * The default theme is the brand's: ink and cream, tomato for the accent, basil for success, pasta for warnings. The
 * user named greyscale the most legible theme there is, so ragu reads at least as well as greyscale on every pair it
 * has in common with it, the brand's colours lightened or darkened where they would not.
 */
describe("the ragu theme", () => {
  const BRAND = {
    ink: "#120d0b",
    cream: "#f4e7cd",
    tomato: "#df4a2b",
    basil: "#4f8a2e",
    pasta: "#f1c14f",
    pastaDark: "#c98f2a",
  }
  const hue = (c: RGBA) => toOklch(c).h
  /** Apart by less than `max` radians on the hue circle. */
  const near = (a: RGBA, b: RGBA, max = 0.25) => {
    const d = Math.abs(hue(a) - hue(b)) % (2 * Math.PI)
    return Math.min(d, 2 * Math.PI - d) < max
  }

  for (const mode of ["dark", "light"] as const) {
    test(`reads at least as well as greyscale on every pair in ${mode} mode`, async () => {
      const greyscale = new Map((await measure("greyscale", mode)).map((m) => [m.id, m.ratio]))
      const ragu = await measure("ragu", mode)
      expect(ragu.length).toBe(greyscale.size)
      const worse = ragu
        .filter((m) => m.ratio < greyscale.get(m.id)!)
        .map((m) => `${m.id}: ${m.ratio.toFixed(2)} < greyscale ${greyscale.get(m.id)!.toFixed(2)} (${m.where})`)
      expect(worse).toEqual([])
    })

    // The captures showed code on the diff's context lines and on the panel (a written file's view) under 4.5:1, in
    // greyscale too: pairs the catalog test does not measure yet. Ragu reaches the floor there.
    test(`its code reaches 4.5:1 on the diff's context lines and on the panel in ${mode} mode`, async () => {
      const t = createStandaloneTheme({ document: await loadBuiltInTheme("ragu"), mode }).theme
      const ground = over(t.surface.base, TERMINAL[mode])
      const colours = { ...t.syntax, error: t.status.error.fg, warning: t.status.warning.fg, info: t.status.info.fg }
      const low: string[] = []
      for (const [where, fill] of Object.entries({ context: t.diff.contextBg, panel: t.surface.panel })) {
        const bg = over(fill, ground)
        for (const [name, fg] of Object.entries(colours))
          if (ratio(fg, bg) < 4.5) low.push(`${name}/${where}: ${ratio(fg, bg).toFixed(2)}`)
      }
      expect(low).toEqual([])
    })

    test(`wears the brand's colours in ${mode} mode`, async () => {
      const t = createStandaloneTheme({ document: await loadBuiltInTheme("ragu"), mode }).theme
      const rgb = RGBA.fromHex
      expect(t.surface.base).toEqual(rgb(mode === "dark" ? BRAND.ink : BRAND.cream))
      expect(near(t.accent.fg, rgb(BRAND.tomato))).toBe(true)
      expect(near(t.border.active, rgb(BRAND.tomato))).toBe(true)
      expect(near(t.status.success.fg, rgb(BRAND.basil))).toBe(true)
      expect(near(t.status.warning.fg, rgb(mode === "dark" ? BRAND.pasta : BRAND.pastaDark))).toBe(true)
      // The error is a red apart from the tomato of the accent, or every link would look like a failure.
      expect(near(t.status.error.fg, t.accent.fg, 0.12)).toBe(false)
      // Ink and cream warm: the surfaces and the text lean to the brand's hue, never to a cold grey.
      for (const c of [t.surface.panel, t.surface.offset, t.foreground.default, t.foreground.muted])
        expect(near(c, rgb(BRAND.ink), 0.8)).toBe(true)
    })
  }
})

/** The two palettes of phase A: the default of Windows Terminal and conhost, and the light scheme it ships. */
const PALETTES: Record<"dark" | "light", { name: string; colors: TerminalColors }> = {
  dark: {
    name: "Campbell",
    colors: {
      defaultBackground: "#0c0c0c",
      defaultForeground: "#cccccc",
      palette: [
        "#0c0c0c",
        "#c50f1f",
        "#13a10e",
        "#c19c00",
        "#0037da",
        "#881798",
        "#3a96dd",
        "#cccccc",
        "#767676",
        "#e74856",
        "#16c60c",
        "#f9f1a5",
        "#3b78ff",
        "#b4009e",
        "#61d6d6",
        "#f2f2f2",
      ],
    } as TerminalColors,
  },
  light: {
    name: "One Half Light",
    colors: {
      defaultBackground: "#fafafa",
      defaultForeground: "#383a42",
      palette: [
        "#383a42",
        "#e45649",
        "#50a14f",
        "#c18401",
        "#0184bc",
        "#a626a4",
        "#0997b3",
        "#fafafa",
        "#4f525d",
        "#df6c75",
        "#98c379",
        "#e4c07a",
        "#61afef",
        "#c577dd",
        "#56b5c2",
        "#ffffff",
      ],
    } as TerminalColors,
  },
}

describe("the system theme", () => {
  for (const mode of ["dark", "light"] as const) {
    const { name, colors } = PALETTES[mode]
    test(`on ${name}, every pair reaches its floor`, () => {
      const failing = measureDocument(`system:${name}`, generateSystem(colors), mode).filter((m) => m.ratio < m.min)
      expect(failing.map(describeFailure)).toEqual([])
    })
  }

  test("is light on a light terminal and dark on a dark one, whatever the mode was", () => {
    const dark = generateSystem(PALETTES.dark.colors).theme
    const light = generateSystem(PALETTES.light.colors).theme
    const lum = (c: unknown) => luminance(c as RGBA)
    expect(lum(light.text)).toBeLessThan(lum(light.background))
    expect(lum(light.textMuted)).toBeLessThan(lum(light.background))
    expect(lum(dark.text)).toBeGreaterThan(lum(dark.background))
    expect(lum(dark.textMuted)).toBeGreaterThan(lum(dark.background))
  })
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

  test("the reasoning is drawn in muted, opaque, not the code palette at an alpha", async () => {
    const standalone = createStandaloneTheme({ document: await loadBuiltInTheme("ragu"), mode: "light" })
    const styles = standalone.subtleSyntax().getAllStyles()
    expect(styles.size).toBeGreaterThan(10)
    for (const style of styles.values()) {
      if (!style.fg) continue
      expect(style.fg.a).toBe(1)
      expect(style.fg).toEqual(standalone.theme.foreground.muted)
    }
  })
})
