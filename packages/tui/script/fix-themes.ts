#!/usr/bin/env bun
/**
 * Moves the colours of the built-in themes, in lightness only, until each reaches the floor of the triple-A review
 * on every surface the screens draw it on.
 *
 * For each theme, each mode and each colour drawn as text (or as a mark), it takes the backgrounds the colour lands
 * on and the floor on each: body text 7:1; secondary text, coloured text and code 4.5:1; marks 3:1. When the colour
 * misses one, its OKLCH lightness moves as little as it takes, against the worst of them. The hue stays and the
 * chroma drops only as far as sRGB needs, so the theme keeps its character. The new colour is written as a literal on
 * that key and mode only: the diff names the token that moved, and the `defs` the theme shares stay as they are.
 *
 * What a change of lightness cannot fix, a colour drawn on backgrounds both lighter and darker than any colour that
 * would pass, is left as it is and listed: those need a decision by hand.
 *
 * The colours the engine derives (`theme-tokens.ts`: subtle, the selected row, the diff's line numbers and signs) are
 * the engine's business, and the backgrounds are never touched.
 *
 * Usage, from packages/tui:
 *   bun script/fix-themes.ts                    rewrite the documents and print a summary
 *   bun script/fix-themes.ts --check            report only; exit 1 when a document would change
 *   bun script/fix-themes.ts --report <file>    also write every change and every pair left open, in markdown
 */
import { readdir } from "node:fs/promises"
import path from "node:path"
import { RGBA } from "@opentui/core"
import { resolveTheme } from "../src/context/theme"
import { contrastRatio, contrastScore, ensureContrastFor, over, type ContrastTarget } from "../src/context/contrast"

type Mode = "dark" | "light"
type Doc = { theme: Record<string, unknown> }
type Colours = Record<string, RGBA>

const DIR = path.join(import.meta.dir, "../src/context/theme")
const MODES: Mode[] = ["dark", "light"]
/** What a transparent theme background shows: the default of Windows Terminal and conhost, or white. */
const TERMINAL: Record<Mode, RGBA> = { dark: RGBA.fromHex("#0c0c0c"), light: RGBA.fromHex("#ffffff") }

const SURFACES = ["background", "backgroundPanel", "backgroundElement", "backgroundMenu"]
const DIFF_LINES = ["diffAddedBg", "diffRemovedBg"]
const SYNTAX = ["Comment", "Keyword", "Function", "Variable", "String", "Number", "Type", "Operator", "Punctuation"]
const MARKDOWN = ["Link", "LinkText", "Code", "BlockQuote", "Emph", "ListItem", "ListEnumeration"]

/**
 * Which colours, on which backgrounds, at which floor: the pairs of `test/tui/theme-contrast.test.ts`, by document
 * key. In this order, so a colour that others refer to (`text`, `textMuted`) is settled before them.
 */
const RULES: [keys: string[], on: [backgrounds: string[], min: number][]][] = [
  [["text"], [[[...SURFACES, ...DIFF_LINES, "diffContextBg"], 7]]],
  [["markdownText", "markdownHeading", "markdownStrong", "markdownCodeBlock"], [[["background"], 7]]],
  [["textMuted"], [[SURFACES, 4.5]]],
  [
    ["primary"],
    [
      [["background"], 4.5],
      [["backgroundPanel"], 3],
    ],
  ],
  [["accent", "secondary", ...MARKDOWN.map((k) => `markdown${k}`)], [[["background"], 4.5]]],
  [["error", "warning", "success", "info"], [[["background", "backgroundPanel"], 4.5]]],
  [SYNTAX.map((k) => `syntax${k}`), [[["background", ...DIFF_LINES], 4.5]]],
  [["borderActive"], [[["background"], 3]]],
]

/** The backgrounds, which no change may reach: a key that refers to a moved colour would follow it. */
const BACKGROUNDS = [
  ...SURFACES,
  ...DIFF_LINES,
  "diffContextBg",
  "diffAddedLineNumberBg",
  "diffRemovedLineNumberBg",
  "border",
  "borderSubtle",
]

const hex = (c: RGBA) =>
  "#" +
  [c.r, c.g, c.b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")

type Change = { theme: string; mode: Mode; key: string; from: string; to: string; before: number; after: number }
type Open = {
  theme: string
  mode: Mode
  key: string
  colour: string
  worst: string
  ratio: number
  min: number
  best: number
}

/**
 * The document's colours for `mode`, by their document keys. The resolved theme carries them flat, except the two
 * whose names its token groups take over: `accent` (the group; the colour is `accent.alt`) and `border`.
 */
function resolve(doc: Doc, mode: Mode): Colours {
  const theme = resolveTheme(doc as never, mode)
  return { ...(theme as unknown as Colours), accent: theme.accent.alt, border: theme.border.default }
}

/** The backgrounds a key is drawn on in `mode`, laid over the terminal as the screen shows them. */
function targetsOf(colours: Colours, mode: Mode, on: [string[], number][]): (ContrastTarget & { name: string })[] {
  const base = over(colours.background!, TERMINAL[mode])
  return on.flatMap(([names, min]) =>
    names.map((name) => ({ name, min, bg: over(over(colours[name]!, base), TERMINAL[mode]) })),
  )
}

/** The worst of a colour's targets: the background where it falls shortest of its floor. */
function worstOf(colour: RGBA, targets: (ContrastTarget & { name: string })[]) {
  return targets
    .map((t) => ({ ...t, ratio: contrastRatio(colour, t.bg) }))
    .sort((a, b) => a.ratio / a.min - b.ratio / b.min)[0]!
}

/** Writes `value` on `key` for `mode` only; a value shared by both modes is split into its two variants first. */
function write(doc: Doc, key: string, mode: Mode, value: string) {
  const current = doc.theme[key]
  if (current && typeof current === "object" && !Array.isArray(current)) {
    ;(current as Record<Mode, unknown>)[mode] = value
    return
  }
  doc.theme[key] = mode === "dark" ? { dark: value, light: current } : { dark: current, light: value }
}

async function fixTheme(id: string, doc: Doc) {
  const changes: Change[] = []
  const open: Open[] = []
  const backgroundsBefore = MODES.map((mode) => BACKGROUNDS.map((k) => hex(resolve(doc, mode)[k]!)).join())
  for (const mode of MODES) {
    for (const [keys, on] of RULES) {
      for (const key of keys) {
        if (doc.theme[key] === undefined) continue
        const colours = resolve(doc, mode)
        const targets = targetsOf(colours, mode, on)
        const colour = colours[key]!
        if (contrastScore(colour, targets) >= 1) continue
        const worst = worstOf(colour, targets)
        const fixed = ensureContrastFor(colour, targets)
        if (contrastScore(fixed, targets) < 1) {
          const best = worstOf(fixed, targets)
          open.push({
            theme: id,
            mode,
            key,
            colour: hex(over(colour, worst.bg)),
            worst: worst.name,
            ratio: worst.ratio,
            min: worst.min,
            best: best.ratio,
          })
          continue
        }
        write(doc, key, mode, hex(fixed))
        changes.push({
          theme: id,
          mode,
          key,
          from: hex(over(colour, worst.bg)),
          to: hex(fixed),
          before: worst.ratio,
          after: worstOf(fixed, targets).ratio,
        })
      }
    }
  }
  const backgroundsAfter = MODES.map((mode) => BACKGROUNDS.map((k) => hex(resolve(doc, mode)[k]!)).join())
  if (backgroundsAfter.join() !== backgroundsBefore.join())
    throw new Error(`${id}: a background followed a moved colour; pin it before running this script`)
  return { changes, open }
}

const args = process.argv.slice(2)
const check = args.includes("--check")
const reportAt = args.includes("--report") ? args[args.indexOf("--report") + 1] : undefined

const files = (await readdir(DIR)).filter((f) => f.endsWith(".json")).sort()
const changes: Change[] = []
const open: Open[] = []
let rewritten = 0
for (const file of files) {
  const fullPath = path.join(DIR, file)
  const text = await Bun.file(fullPath).text()
  const doc = JSON.parse(text) as Doc
  const result = await fixTheme(path.basename(file, ".json"), doc)
  changes.push(...result.changes)
  open.push(...result.open)
  const next = JSON.stringify(doc, null, 2) + "\n"
  if (next === text) continue
  rewritten++
  if (!check) await Bun.write(fullPath, next)
}

const r = (n: number) => n.toFixed(2)
console.log(
  `${files.length} documents, ${changes.length} colours moved in ${rewritten} of them, ${open.length} pairs left open`,
)
for (const o of open)
  console.log(`  open: ${o.theme}/${o.mode} ${o.key} on ${o.worst}: ${r(o.ratio)} < ${o.min} (best ${r(o.best)})`)

if (reportAt) {
  const lines = [
    "# fix-themes.ts",
    "",
    `${files.length} documents, ${changes.length} colours moved in ${rewritten} of them, ${open.length} pairs left open.`,
    "",
    "## Left open",
    "",
    "| theme | mode | key | colour | worst background | ratio | floor | best a lightness reaches |",
    "|---|---|---|---|---|---|---|---|",
    ...open.map(
      (o) =>
        `| ${o.theme} | ${o.mode} | ${o.key} | ${o.colour} | ${o.worst} | ${r(o.ratio)} | ${o.min} | ${r(o.best)} |`,
    ),
    "",
    "## Moved",
    "",
    "| theme | mode | key | from | to | worst ratio before | after |",
    "|---|---|---|---|---|---|---|",
    ...changes.map(
      (c) => `| ${c.theme} | ${c.mode} | ${c.key} | ${c.from} | ${c.to} | ${r(c.before)} | ${r(c.after)} |`,
    ),
    "",
  ]
  await Bun.write(reportAt, lines.join("\n"))
}

if (check && rewritten > 0) process.exit(1)
