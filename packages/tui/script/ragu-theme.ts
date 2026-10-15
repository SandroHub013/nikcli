#!/usr/bin/env bun
/**
 * Writes the ragu theme, `src/context/theme/ragu.json`, from the brand's palette and greyscale's contrasts.
 *
 * The user chose the brand's palette for the default theme (ink and cream, tomato for the accent, basil for success,
 * pasta for warnings) and named greyscale the most legible theme in the catalog. So greyscale is both the shape and
 * the ruler:
 * - the surfaces are its steps of OKLCH lightness laid on ink (dark) and on cream (light), in the brand's warm hue;
 * - the text and the other neutrals take that warm hue too: cream in the dark, ink in the light;
 * - the accent, success, warning, the active border and the diff's tints are the brand's, the error a red apart from
 *   the tomato;
 * - every other colour, the syntax and the markdown, starts as greyscale's.
 * Then each colour moves in OKLCH lightness, hue kept, until every pair it is drawn in reads at least as well as the
 * same pair in greyscale and reaches the floor of `test/tui/theme-contrast.test.ts`. The pairs are that test's.
 *
 * Usage, from packages/tui:
 *   bun script/ragu-theme.ts                                       rewrite ragu.json
 *   bun script/ragu-theme.ts --report <file.md> [--before <json>]  also write every pair, greyscale against ragu
 *                                                                  (and against an earlier ragu document)
 */
import path from "node:path"
import { RGBA } from "@opentui/core"
import { createStandaloneTheme, resolveTheme, type Theme } from "../src/context/theme"
import { contrastRatio, over, relativeLuminance, toOklch, withLightness } from "../src/context/contrast"
import greyscale from "../src/context/theme/greyscale.json" with { type: "json" }

type Mode = "dark" | "light"
type Doc = { defs?: Record<string, string>; theme: Record<string, unknown> }

const OUT = path.join(import.meta.dir, "../src/context/theme/ragu.json")
const MODES: Mode[] = ["dark", "light"]
/** What a transparent background shows: the default of Windows Terminal and conhost, or white. */
const TERMINAL: Record<Mode, RGBA> = { dark: RGBA.fromHex("#0c0c0c"), light: RGBA.fromHex("#ffffff") }

/** The brand's palette: `ade-team/design/ragu-code/gen/logo.mjs`. */
const BRAND = {
  ink: "#120d0b",
  cream: "#f4e7cd",
  tomato: "#df4a2b",
  red: "#a3271b",
  basil: "#4f8a2e",
  pasta: "#f1c14f",
  pastaDark: "#c98f2a",
}
const brand = (name: keyof typeof BRAND) => RGBA.fromHex(BRAND[name])
const DEG = Math.PI / 180

// ─── the pairs ───────────────────────────────────────────────────────────────────────────────────────────────────

type Pair = {
  id: string
  /** The document key whose lightness moves when the pair falls short. */
  key: string
  floor: number
  fg: RGBA
  bg: RGBA
  /** The key is the fill, not the text: the selected row, whose fill is `primary`. */
  fill: boolean
}

/** Keys that are the body text under another name: they stay equal to it, and their pairs move it. */
const FOLLOWS: Record<string, string> = { markdownText: "text", markdownCodeBlock: "text", syntaxVariable: "text" }

const TEXT = 7
const SECONDARY = 4.5
const GRAPHIC = 3

function pairs(t: Theme, reasoning: RGBA): Pair[] {
  const out: Pair[] = []
  const add = (id: string, key: string, floor: number, fg: RGBA, bg: RGBA, fill = false) =>
    out.push({ id, key: FOLLOWS[key] ?? key, floor, fg, bg, fill })
  const { base, panel, offset, overlay } = t.surface
  const surfaces = { base, panel, offset, overlay }
  for (const [name, bg] of Object.entries(surfaces)) add(`text/${name}`, "text", TEXT, t.foreground.default, bg)
  add("markdown.text/base", "markdownText", TEXT, t.markdown.text, base)
  add("markdown.heading/base", "markdownHeading", TEXT, t.markdown.heading, base)
  add("markdown.strong/base", "markdownStrong", TEXT, t.markdown.strong, base)
  add("markdown.codeBlock/base", "markdownCodeBlock", TEXT, t.markdown.codeBlock, base)
  add("selection/badge", "primary", TEXT, t.badge.fg, t.badge.bg, true)
  add("diff.text/added", "text", TEXT, t.foreground.default, t.diff.addedBg)
  add("diff.text/removed", "text", TEXT, t.foreground.default, t.diff.removedBg)
  add("diff.text/context", "text", TEXT, t.foreground.default, t.diff.contextBg)

  for (const [name, bg] of Object.entries(surfaces))
    add(`muted/${name}`, "textMuted", SECONDARY, t.foreground.muted, bg)
  add("subtle/base", "textMuted", SECONDARY, t.foreground.subtle, base)
  add("reasoning/base", "textMuted", SECONDARY, reasoning, base)
  add("diff.number/context", "diffLineNumber", SECONDARY, t.diff.lineNumber, t.diff.contextBg)
  add("diff.number/added", "diffLineNumber", SECONDARY, t.diff.lineNumber, t.diff.addedLineNumberBg)
  add("diff.number/removed", "diffLineNumber", SECONDARY, t.diff.lineNumber, t.diff.removedLineNumberBg)

  for (const [name, bg] of Object.entries(surfaces)) {
    add(`accent/${name}`, "primary", SECONDARY, t.accent.fg, bg)
    add(`accent.alt/${name}`, "accent", SECONDARY, t.accent.alt, bg)
    add(`secondary/${name}`, "secondary", SECONDARY, t.accent.secondary, bg)
    for (const k of ["error", "warning", "success", "info"] as const)
      add(`${k}/${name}`, k, SECONDARY, t.status[k].fg, bg)
  }
  for (const k of ["error", "warning"] as const) {
    add(`${k}/own-fill`, k, SECONDARY, t.status[k].fg, t.status[k].bg)
    add(`text/${k}-fill`, "text", TEXT, t.foreground.default, t.status[k].bg)
    add(`muted/${k}-fill`, "textMuted", SECONDARY, t.foreground.muted, t.status[k].bg)
  }
  for (const k of ["link", "linkText", "code", "blockQuote", "emph", "listItem", "listEnumeration"] as const)
    add(`markdown.${k}/base`, `markdown${k[0]!.toUpperCase()}${k.slice(1)}`, SECONDARY, t.markdown[k], base)
  add("diff.sign+/added", "diffHighlightAdded", SECONDARY, t.diff.highlightAdded, t.diff.addedLineNumberBg)
  add("diff.sign-/removed", "diffHighlightRemoved", SECONDARY, t.diff.highlightRemoved, t.diff.removedLineNumberBg)

  for (const k of Object.keys(t.syntax) as (keyof Theme["syntax"])[]) {
    const key = `syntax${k[0]!.toUpperCase()}${k.slice(1)}`
    add(`syntax.${k}/base`, key, SECONDARY, t.syntax[k], base)
    add(`syntax.${k}/added`, key, SECONDARY, t.syntax[k], t.diff.addedBg)
    add(`syntax.${k}/removed`, key, SECONDARY, t.syntax[k], t.diff.removedBg)
  }
  for (const k of ["error", "warning", "info"] as const) {
    add(`syntax.${k}/added`, k, SECONDARY, t.status[k].fg, t.diff.addedBg)
    add(`syntax.${k}/removed`, k, SECONDARY, t.status[k].fg, t.diff.removedBg)
  }

  add("border.active/base", "borderActive", GRAPHIC, t.border.active, base)
  add("focus/base", "primary", GRAPHIC, t.border.focus, base)
  add("selection.bar/overlay", "primary", GRAPHIC, t.badge.bg, overlay)
  add("accent.bar/panel", "primary", GRAPHIC, t.accent.fg, panel)
  add("border/base", "border", 1, t.border.default, base)
  add("border/overlay", "border", 1, t.border.default, overlay)
  add("border.subtle/base", "borderSubtle", 1, t.border.subtle, base)
  return out
}

type Measured = Pair & { ratio: number }

/** Every pair of a document in `mode`, laid over the terminal the way the screen shows it. */
function measure(document: unknown, mode: Mode): Measured[] {
  const standalone = createStandaloneTheme({ document, mode })
  const t = standalone.theme
  const reasoning = standalone.subtleSyntax().getStyle("default")?.fg ?? t.foreground.default
  const base = over(t.surface.base, TERMINAL[mode])
  return pairs(t, reasoning).map((p) => {
    const bg = over(over(p.bg, base), TERMINAL[mode])
    const fg = over(p.fg, bg)
    return { ...p, fg, bg, ratio: contrastRatio(fg, bg) }
  })
}

// ─── the starting colours ────────────────────────────────────────────────────────────────────────────────────────

const lightness = (c: RGBA) => toOklch(c).l
function linear(l: number, c: number, h: number): number[] {
  const A = c * Math.cos(h)
  const B = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}
const inGamut = (rgb: number[]) => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6)

/** The colour at OKLCH lightness `l`, chroma `c` and hue `h` (radians), the chroma lowered as far as sRGB needs. */
function lch(l: number, c: number, h: number): RGBA {
  let chroma = c
  if (!inGamut(linear(l, c, h))) {
    let lo = 0
    let hi = c
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(linear(l, mid, h))) lo = mid
      else hi = mid
    }
    chroma = lo
  }
  const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
  const [r, g, b] = linear(l, chroma, h).map((v) => Math.round(encode(Math.min(1, Math.max(0, v))) * 255))
  return RGBA.fromInts(r!, g!, b!)
}

/** greyscale's colours in `mode`, by document key. */
function greyscaleColours(mode: Mode): Record<string, RGBA> {
  const resolved = resolveTheme(greyscale as never, mode) as unknown as Record<string, RGBA> & {
    accent: { alt: RGBA }
    border: { default: RGBA }
  }
  const out: Record<string, RGBA> = {}
  for (const key of Object.keys(greyscale.theme)) out[key] = resolved[key] as RGBA
  out.accent = resolved.accent.alt
  out.border = resolved.border.default
  return out
}

/** The backgrounds: they never move, the colours drawn on them do. */
const BACKGROUNDS = new Set([
  "background",
  "backgroundPanel",
  "backgroundElement",
  "diffContextBg",
  "diffAddedBg",
  "diffRemovedBg",
  "diffAddedLineNumberBg",
  "diffRemovedLineNumberBg",
])
/** Greyscale's neutrals drawn as text or lines: they take the brand's warm hue. */
const NEUTRALS = [
  "textMuted",
  "diffContext",
  "diffLineNumber",
  "markdownBlockQuote",
  "markdownHorizontalRule",
  "syntaxComment",
  "syntaxOperator",
  "syntaxPunctuation",
]

function start(mode: Mode): Record<string, RGBA> {
  const grey = greyscaleColours(mode)
  const base = mode === "dark" ? brand("ink") : brand("cream")
  const cream = toOklch(brand("cream"))
  const ink = toOklch(brand("ink"))
  // The surfaces take ink's hue in the dark and cream's in the light; what is drawn on them takes the other one.
  const ground = mode === "dark" ? { h: ink.h, c: 0.012 } : { h: cream.h, c: cream.c }
  const drawn = mode === "dark" ? { h: cream.h, c: 0.025 } : { h: ink.h, c: 0.02 }
  const step = (key: string) => lightness(base) + lightness(grey[key]!) - lightness(grey.background!)
  const out: Record<string, RGBA> = { ...grey, background: base }

  // The surfaces and the lines on them: greyscale's steps of lightness from its background, laid on ink or cream.
  for (const key of ["backgroundPanel", "backgroundElement", "diffContextBg", "border", "borderSubtle"])
    out[key] = lch(step(key), ground.c, ground.h)
  // The diff's fills: greyscale's step and chroma, in the brand's basil and tomato.
  const basil = toOklch(brand("basil")).h
  const tomato = toOklch(brand("tomato")).h
  for (const [key, h] of [
    ["diffAddedBg", basil],
    ["diffAddedLineNumberBg", basil],
    ["diffRemovedBg", tomato],
    ["diffRemovedLineNumberBg", tomato],
  ] as const)
    out[key] = lch(step(key), toOklch(grey[key]!).c, h)

  for (const key of NEUTRALS) out[key] = lch(lightness(grey[key]!), drawn.c, drawn.h)
  // Body text: cream itself in the dark; in the light, greyscale's text in ink's hue.
  const text = mode === "dark" ? brand("cream") : lch(lightness(grey.text!), drawn.c, drawn.h)
  for (const key of ["text", "markdownText", "markdownCodeBlock", "syntaxVariable"]) out[key] = text

  for (const key of ["primary", "borderActive", "markdownHeading"]) out[key] = brand("tomato")
  for (const key of ["success", "diffAdded", "diffHighlightAdded"]) out[key] = brand("basil")
  out.warning = mode === "dark" ? brand("pasta") : brand("pastaDark")
  // The error: the brand's red turned toward crimson, so it never reads as the accent's tomato.
  const red = toOklch(brand("red"))
  const error = lch(lightness(grey.error!), red.c, red.h - 20 * DEG)
  for (const key of ["error", "diffRemoved", "diffHighlightRemoved"]) out[key] = error
  return out
}

// ─── moving the colours ──────────────────────────────────────────────────────────────────────────────────────────

const hex = (c: RGBA) =>
  "#" +
  [c.r, c.g, c.b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")

function document(colours: Record<Mode, Record<string, RGBA>>): Doc {
  const theme: Record<string, unknown> = {}
  for (const key of Object.keys(greyscale.theme)) {
    const [dark, light] = MODES.map((mode) => hex(colours[mode][key]!))
    theme[key] = { dark, light }
  }
  theme.background = { dark: "ink", light: "cream" }
  return { defs: { ink: BRAND.ink, cream: BRAND.cream }, theme }
}

/** One mode's colours, each moved until its pairs reach greyscale's ratio and their floor. */
function settle(mode: Mode, target: Map<string, number>): Record<string, RGBA> {
  const colours = start(mode)
  const origin = { ...colours }
  const l: Record<string, number> = Object.fromEntries(Object.entries(colours).map(([k, c]) => [k, lightness(c)]))
  const STEP = 0.002
  for (let round = 0; round < 4000; round++) {
    const other = mode === "dark" ? "light" : "dark"
    const doc = document({ [mode]: colours, [other]: colours } as Record<Mode, Record<string, RGBA>>)
    const short = measure(doc, mode).filter((p) => p.ratio < target.get(p.id)!)
    if (short.length === 0) return colours
    const moves = new Map<string, number>()
    for (const p of short) {
      if (BACKGROUNDS.has(p.key)) throw new Error(`${mode} ${p.id}: the pair would move a background, ${p.key}`)
      // Away from the other colour of the pair: lighter when it is the lighter one, darker when not.
      const [moving, other] = p.fill ? [p.bg, p.fg] : [p.fg, p.bg]
      const direction = relativeLuminance(moving) >= relativeLuminance(other) ? 1 : -1
      const seen = moves.get(p.key)
      if (seen !== undefined && seen !== direction) throw new Error(`${mode} ${p.key}: its pairs pull it both ways`)
      moves.set(p.key, direction)
    }
    for (const [key, direction] of moves) {
      l[key] = Math.min(1, Math.max(0, l[key]! + direction * STEP))
      colours[key] = withLightness(origin[key]!, l[key]!)
    }
    for (const [key, leader] of Object.entries(FOLLOWS)) colours[key] = colours[leader]!
  }
  throw new Error(`${mode}: no settling in 4000 steps`)
}

// ─── main ────────────────────────────────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flag = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

const reference = Object.fromEntries(
  MODES.map((mode) => {
    const map = new Map<string, number>()
    for (const p of measure(greyscale, mode)) map.set(p.id, Math.max(p.floor, p.ratio))
    return [mode, map]
  }),
) as Record<Mode, Map<string, number>>

const settled = Object.fromEntries(MODES.map((mode) => [mode, settle(mode, reference[mode])])) as Record<
  Mode,
  Record<string, RGBA>
>
const doc = document(settled)
await Bun.write(OUT, JSON.stringify(doc, null, 2) + "\n")
console.log(`wrote ${path.relative(process.cwd(), OUT)}`)

const report = flag("--report")
if (report) {
  const beforePath = flag("--before")
  const before = beforePath ? await Bun.file(beforePath).json() : undefined
  const rows: string[] = []
  for (const mode of MODES) {
    const grey = new Map(measure(greyscale, mode).map((p) => [p.id, p.ratio]))
    const old = before ? new Map(measure(before, mode).map((p) => [p.id, p.ratio])) : undefined
    for (const p of measure(doc, mode)) {
      const g = grey.get(p.id)!
      const cells = [mode, p.id, g.toFixed(2)]
      if (old) cells.push(old.get(p.id)!.toFixed(2))
      cells.push(p.ratio.toFixed(2), (p.ratio - g >= 0 ? "+" : "") + (p.ratio - g).toFixed(2))
      rows.push(`| ${cells.join(" | ")} |`)
    }
  }
  const cols = ["mode", "pair", "greyscale", ...(before ? ["ragu before"] : []), "ragu", "ragu − greyscale"]
  const head = [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`]
  await Bun.write(report, [...head, ...rows].join("\n") + "\n")
  console.log(`wrote ${report}`)
}
