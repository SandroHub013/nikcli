#!/usr/bin/env bun
/**
 * NIKCLI logo lab.
 *
 * Renders the NIKCLI wordmark in a spread of ASCII/Unicode styles inside a real
 * terminal through OpenTUI, so the candidates can be looked at instead of
 * reasoned about. Every style is either one hand-authored figlet grid or a
 * rasterisation of one shared 5x7 grid — what changes between them is the
 * *rendering* (solid, depth, outline, halftone, slant, half-block, hairline),
 * not the letterforms.
 *
 * Usage:
 *   bun run script/logo-lab.ts                 interactive browser
 *   bun run script/logo-lab.ts --capture       plain text of every style
 *   bun run script/logo-lab.ts --production    plain text of the shipped logo
 *   bun run script/logo-lab.ts --html=<path>   self-contained contact sheet
 *   bun run script/logo-lab.ts --style=block   start on one style
 */
import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  createCliRenderer,
  fg,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core"
import { logo as productionLogo } from "@/cli/logo"

// ---------------------------------------------------------------------------
// palette
// ---------------------------------------------------------------------------

const BG = "#0b0d10"
const MUTED = "#6b7684"
const DEFAULT = "#e6edf3"
const ACCENT = "#7ee787"
const INFO = "#79c0ff"
const WARN = "#e3b341"

/** The production logo's ramp, copied from `packages/tui/src/component/logo.tsx`. */
const PRODUCTION_RAMP = [0.48, 0.62, 0.82, 1, 0.72, 0.5]

function mix(from: string, to: string, amount: number): string {
  const channel = (hex: string, offset: number) => parseInt(hex.slice(offset, offset + 2), 16)
  const blend = (a: number, b: number) => Math.round(a + (b - a) * amount)
  const parts = [1, 3, 5].map((offset) =>
    blend(channel(from, offset), channel(to, offset)).toString(16).padStart(2, "0"),
  )
  return `#${parts.join("")}`
}

/** Bell curve: the middle rows read brightest, exactly like the shipped logo. */
export function rowRamp(height: number): number[] {
  if (height === PRODUCTION_RAMP.length) return PRODUCTION_RAMP
  return Array.from({ length: height }, (_, row) => {
    const position = height === 1 ? 0.5 : row / (height - 1)
    return 0.45 + 0.55 * Math.sin(Math.PI * position)
  })
}

// ---------------------------------------------------------------------------
// letterforms
// ---------------------------------------------------------------------------

type Glyph = readonly string[]

/** 5x7 solid grid — the source every generated style rasterises. */
const BIG: Record<string, Glyph> = {
  N: ["█   █", "█   █", "██  █", "█ █ █", "█  ██", "█   █", "█   █"],
  I: ["█████", "  █  ", "  █  ", "  █  ", "  █  ", "  █  ", "█████"],
  K: ["█   █", "█  █ ", "█ █  ", "███  ", "█ █  ", "█  █ ", "█   █"],
  C: [" ████", "█    ", "█    ", "█    ", "█    ", "█    ", " ████"],
  L: ["█    ", "█    ", "█    ", "█    ", "█    ", "█    ", "█████"],
}

/** Half blocks: four rows tall, for narrow terminals and busy headers. */
const CHUNKY: Record<string, Glyph> = {
  N: ["▄▄▄▄▄", "█   █", "█   █", "▀▀▀▀▀"],
  I: ["▄▄▄", " █ ", " █ ", "▀▀▀"],
  K: ["█▀▀▀▀", "█ ██ ", "█▄▄▄▄", "▀   ▀▀"],
  C: [" ▄▀▀▀", "█    ", "█    ", " ▀▀▀▀"],
  L: ["█    ", "█    ", "█    ", "▀▀▀▀▀"],
}

/** Box drawing: hairline strokes that hold up at 1x on any terminal font. */
const LINE: Record<string, Glyph> = {
  N: ["┌─┐┬", "│ ││", "│ ├┤", "└─┘┘"],
  I: ["┌─┐", "│ │", "├─┤", "└─┘"],
  K: ["┌─┐┬", "│ ├┤", "│ ││", "└─┘┘"],
  C: ["╭───", "│   ", "│   ", "╰───"],
  L: ["│   ", "│   ", "│   ", "╰───"],
}

const WORD = "NIKCLI"

function compose(set: Record<string, Glyph>, gap = " "): string[] {
  const glyphs = [...WORD].map((char) => set[char]!)
  const widths = glyphs.map((glyph) => Math.max(...glyph.map((row) => row.length)))
  const height = Math.max(...glyphs.map((glyph) => glyph.length))
  return Array.from({ length: height }, (_, row) =>
    glyphs.map((glyph, index) => (glyph[row] ?? "").padEnd(widths[index]!, " ")).join(gap),
  )
}

// ---------------------------------------------------------------------------
// rasterisers — one grid, several renderings
// ---------------------------------------------------------------------------

function filledCells(lines: readonly string[]): [row: number, col: number][] {
  const out: [number, number][] = []
  lines.forEach((line, row) => {
    for (let col = 0; col < line.length; col++) if (line[col] === "█") out.push([row, col])
  })
  return out
}

function emptyGrid(height: number, width: number): string[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => " "))
}

/** Filled cells get a soft ramp, so the wordmark has weight without more glyphs. */
function halftone(lines: readonly string[]): string[] {
  const shades = ["░", "░", "▒", "▒", "▓", "▓", "█"]
  const ramp = rowRamp(lines.length)
  const grid = emptyGrid(lines.length, Math.max(...lines.map((line) => line.length)))
  for (const [row, col] of filledCells(lines)) {
    grid[row]![col] = shades[Math.min(shades.length - 1, Math.round(ramp[row]! * 6))]!
  }
  return grid.map((row) => row.join(""))
}

/**
 * Hollow out the inside of every horizontal stroke, so the letters read as
 * outline rather than solid. A four-neighbour test finds nothing here — a 5x7
 * grid has no enclosed cells at all — so the test is "both horizontal
 * neighbours are filled", which is what a stroke two cells thick actually is.
 */
function outline(lines: readonly string[]): string[] {
  const at = (row: number, col: number) => lines[row]?.[col] === "█"
  const width = Math.max(...lines.map((line) => line.length))
  return lines.map((_, row) =>
    Array.from({ length: width }, (_, col) => {
      if (!at(row, col)) return " "
      return at(row, col - 1) && at(row, col + 1) ? "░" : "█"
    }).join(""),
  )
}

/**
 * Italic shear: every row one column further right than the row above it.
 */
function slant(lines: readonly string[]): string[] {
  const last = lines.length - 1
  return lines.map((line, row) => " ".repeat(Math.max(0, last - row)) + line)
}

/**
 * Double every column, for a display-width banner. A drop shadow was tried
 * first and is not worth shipping: one cell of shade next to a one-cell stroke
 * turns the wordmark into doubled text rather than depth, which is exactly why
 * the shipped logo gets its lift from colour instead.
 */
function banner(lines: readonly string[]): string[] {
  return lines.map((line) => [...line].map((char) => (char === "█" ? "██" : "  ")).join(""))
}

/**
 * Fill plus a one-cell down-right shadow. Only the 7-bit `ascii` style uses
 * this: `#` against `.` still reads as depth, where `█` against `░` on a dark
 * terminal just muddies the stroke.
 */
function dropShadow(lines: readonly string[], fill: string, shade: string, drop = 1): string[] {
  const grid = emptyGrid(lines.length + drop, Math.max(...lines.map((line) => line.length)) + 1)
  for (const [row, col] of filledCells(lines)) grid[row + drop]![col + 1] = shade
  for (const [row, col] of filledCells(lines)) grid[row]![col] = fill
  return grid.map((row) => row.join("").trimEnd())
}

const CREDIT_TEXT = "◇ by @nikomatt69"
const HINT = "   ←/→ switch · r replay · q quit"

/** Frame the wordmark and its credit, for headers that need a hard edge. */
function badge(lines: readonly string[]): string[] {
  const inner = Math.max(...lines.map((line) => line.length))
  const pad = 2
  const width = inner + pad * 2 + 2
  const frame = (body: string) => `│${" ".repeat(pad)}${body.padEnd(inner + pad, " ")}${" ".repeat(pad)}│`
  const blank = frame("")
  const lead = " ".repeat(Math.max(0, Math.floor((inner - CREDIT_TEXT.length) / 2)))
  return [
    `╭${"─".repeat(width - 2)}╮`,
    blank,
    ...lines.map((line) => frame(line)),
    blank,
    frame(`${lead}${CREDIT_TEXT}`),
    blank,
    `╰${"─".repeat(width - 2)}╯`,
  ]
}

// ---------------------------------------------------------------------------
// style registry
// ---------------------------------------------------------------------------

export type LogoStyle = {
  id: string
  label: string
  note: string
  lines: readonly string[]
}

const BIG_LINES = compose(BIG)

export const STYLES: readonly LogoStyle[] = [
  {
    id: "shadow",
    label: "shadow",
    note: "shipped today — figlet ANSI Shadow, box-drawing diagonals",
    lines: [
      "███╗   ██╗ ██╗ ██╗  ██╗  ██████╗ ██╗      ██╗",
      "████╗  ██║ ██║ ██║ ██╔╝ ██╔════╝ ██║      ██║",
      "██╔██╗ ██║ ██║ █████╔╝  ██║      ██║      ██║",
      "██║╚██╗██║ ██║ ██╔═██╗  ██║      ██║      ██║",
      "██║ ╚████║ ██║ ██║  ██╗ ╚██████╗ ███████╗ ██║",
      "╚═╝  ╚═══╝ ╚═╝ ╚═╝  ╚═╝  ╚═════╝ ╚══════╝ ╚═╝",
    ],
  },
  {
    id: "block",
    label: "block",
    note: "solid 5x7 grid — the cleanest silhouette",
    lines: BIG_LINES,
  },
  {
    id: "banner",
    label: "banner",
    note: "block doubled to display width — 70 columns",
    lines: banner(BIG_LINES),
  },
  {
    id: "outline",
    label: "outline",
    note: "hollow strokes, solid silhouette",
    lines: outline(BIG_LINES),
  },
  {
    id: "halftone",
    label: "halftone",
    note: "░▒▓█ ramp driven by the row luminance",
    lines: halftone(BIG_LINES),
  },
  {
    id: "slant",
    label: "slant",
    note: "italic shear, one extra column per row",
    lines: slant(BIG_LINES),
  },
  {
    id: "ascii",
    label: "ascii",
    note: "7-bit only — # with a . shadow, no Unicode",
    lines: dropShadow(BIG_LINES, "#", "."),
  },
  {
    id: "chunky",
    label: "chunky",
    note: "half blocks, four rows — fits a 40 column header",
    lines: compose(CHUNKY),
  },
  {
    id: "line",
    label: "line",
    note: "hairline box drawing — the narrowest candidate",
    lines: compose(LINE),
  },
  {
    id: "badge",
    label: "badge",
    note: "block framed, credit inside — for a splash header",
    lines: badge(BIG_LINES),
  },
]

export const DEFAULT_STYLE_ID = "shadow"

export function styleById(id: string): LogoStyle {
  return STYLES.find((style) => style.id === id) ?? STYLES[0]!
}

export function logoWidth(style: LogoStyle): number {
  return Math.max(...style.lines.map((line) => line.length))
}

export function logoHeight(style: LogoStyle): number {
  return style.lines.length
}

export function plainFrame(style: LogoStyle): string {
  return [
    `${style.label}  ${logoWidth(style)}x${style.lines.length}  ${style.note}`,
    "",
    ...style.lines,
    "",
    "◇ by @nikomatt69",
  ].join("\n")
}

const escapeHtml = (raw: string) => raw.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!)

/**
 * A self-contained contact sheet of every style, coloured exactly the way the
 * TUI paints them: the row luminance ramp from the shipped logo, applied per
 * row, with the credit in the link colour. Generated from the registry rather
 * than hand-written, so the sheet cannot drift from what the lab renders.
 */
export function htmlSheet(): string {
  const cards = STYLES.map((style) => {
    const ramp = rowRamp(style.lines.length)
    const rows = style.lines
      .map((line, row) => `<span style="color:${mix(MUTED, DEFAULT, ramp[row]!)}">${escapeHtml(line)}</span>`)
      .join("\n")
    return `<section>
  <header><b>${escapeHtml(style.label)}</b><span>${logoWidth(style)}&times;${style.lines.length}</span><em>${escapeHtml(style.note)}</em></header>
  <pre>${rows}</pre>
  <p class="credit">&#9671; <a href="https://github.com/nikomatt69">by @nikomatt69</a></p>
</section>`
  }).join("\n")

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>nikcli &middot; logo lab</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; padding:32px 28px 64px; background:${BG}; color:${DEFAULT};
         font:14px/1.5 ui-sans-serif,-apple-system,"SF Pro Text",system-ui,sans-serif }
  h1 { font-size:18px; font-weight:600; margin:0 0 4px }
  .lede { color:${MUTED}; margin:0 0 28px; max-width:62ch }
  .grid { display:grid; gap:18px; grid-template-columns:repeat(auto-fit,minmax(max-content,1fr)) }
  section { background:#0f1319; border:1px solid #1e2530; border-radius:10px; padding:16px 18px }
  header { display:flex; align-items:baseline; gap:10px; margin-bottom:12px }
  header b { color:${ACCENT}; font-size:13px; letter-spacing:.04em; text-transform:uppercase }
  header span { color:${WARN}; font:11px ui-monospace,SFMono-Regular,Menlo,monospace }
  header em { color:${MUTED}; font-style:normal; font-size:12px }
  pre { margin:0; font:13px/1.15 ui-monospace,SFMono-Regular,Menlo,monospace;
        white-space:pre; overflow-x:auto }
  .credit { margin:10px 0 0; color:${INFO}; font:12px ui-monospace,SFMono-Regular,Menlo,monospace }
  .credit a { color:inherit; text-decoration:none }
  code { background:#161b23; padding:1px 5px; border-radius:4px; color:${DEFAULT} }
</style></head>
<body>
<h1>nikcli &middot; logo lab</h1>
<p class="lede">${STYLES.length} wordmark styles off one shared 5&times;7 grid (plus two hand-authored fonts). Rendered with the shipped logo's row luminance ramp. Run the live one with <code>bun run script/logo-lab.ts</code> &mdash; arrows to switch, <code>r</code> to replay, <code>q</code> to quit.</p>
<div class="grid">
${cards}
</div>
</body></html>`
}

// ---------------------------------------------------------------------------
// reveal — the shine sweep from the TUI home logo
// ---------------------------------------------------------------------------

const SHINE_WIDTH = 5
const REVEAL_MS = 900

/**
 * `fg(color)(text)` returns a bare chunk, and `TextRenderable` wants a
 * `StyledText`. The `t` template builds one, but it cannot take an array of
 * chunks — joining them stringifies to `"[object Object]"`, which paints as
 * literal text — so compose the chunk array through the real constructor.
 */
const styled = (...chunks: TextChunk[]): StyledText => new StyledText(chunks)

function revealRow(line: string, rampValue: number, width: number, progress: number): StyledText {
  const cursor = Math.floor(progress * (width + SHINE_WIDTH))
  const edge = Math.min(width, cursor)
  const shineStart = Math.min(width, Math.max(0, cursor - SHINE_WIDTH))
  const base = mix(MUTED, DEFAULT, rampValue)
  const parts: TextChunk[] = []
  if (shineStart > 0) parts.push(fg(base)(line.slice(0, shineStart)))
  if (edge > shineStart) parts.push(fg(mix(base, DEFAULT, 0.9))(line.slice(shineStart, edge)))
  if (edge < width) parts.push(fg(BG)(" ".repeat(width - edge)))
  return styled(...parts)
}

// ---------------------------------------------------------------------------
// the view — mounted by the interactive app and by the headless test
// ---------------------------------------------------------------------------

export type LogoLabView = {
  setStyle: (id: string) => void
  /** 0 hides everything, 1 is the finished wordmark. */
  setProgress: (progress: number) => void
  current: () => LogoStyle
  destroy: () => void
}

export function mountLab(renderer: CliRenderer, startId: string = DEFAULT_STYLE_ID): LogoLabView {
  let index = Math.max(
    0,
    STYLES.findIndex((style) => style.id === startId),
  )

  // Everything here is a real renderable, not a `Box()`/`Text()` construct.
  // Both constructs return vnode descriptors, and that breaks this view two ways:
  // assigning `.content` to a vnode writes a dead property on the wrapper, and a
  // container built that way silently ignores any child added after it is mounted
  // — which is exactly what a style switch does.
  const label = () => new TextRenderable(renderer as never, { content: "", selectable: false })
  const header = label()
  const stage = new BoxRenderable(renderer as never, {
    flexDirection: "column",
    alignItems: "center",
    flexShrink: 0,
  })
  const credit = label()
  const meta = label()
  const tabs = label()
  const body = new BoxRenderable(renderer as never, {
    flexDirection: "column",
    flexGrow: 1,
    backgroundColor: BG,
    paddingLeft: 1,
    paddingRight: 1,
  })
  const topSpacer = new BoxRenderable(renderer as never, { flexGrow: 1 })
  const bottomSpacer = new BoxRenderable(renderer as never, { flexGrow: 1 })
  // `add` takes a single child (only the `Box()` factory spreads children), and
  // a renderable may only appear once in the tree — two distinct spacers, never
  // the same instance added twice, which silently drops the whole subtree.
  for (const child of [header, topSpacer, stage, credit, meta, bottomSpacer, tabs]) body.add(child)
  renderer.root.add(body)

  let rows: TextRenderable[] = []
  let progress = 0

  function paint() {
    const style = STYLES[index]!
    const width = logoWidth(style)
    const ramp = rowRamp(style.lines.length)

    const position = `· ${style.label} ${index + 1}/${STYLES.length}`
    header.content = styled(fg(ACCENT)("◆ "), fg(DEFAULT)("nikcli "), fg(MUTED)("logo lab "), fg(MUTED)(position))

    for (const row of rows) stage.remove(row)
    rows = style.lines.map((line, row) => {
      const text = new TextRenderable(renderer as never, {
        content: revealRow(line, ramp[row]!, width, progress),
        selectable: false,
      })
      stage.add(text)
      return text
    })

    credit.content = styled(fg(DEFAULT)("◇ "), fg(INFO)("by @nikomatt69"))
    meta.content = styled(fg(WARN)(`${width}x${style.lines.length}`), fg(MUTED)(` ${style.note}`))
    tabs.content = styled(
      ...STYLES.map((candidate, i) => fg(i === index ? ACCENT : MUTED)(` ${candidate.label} `)),
      fg(MUTED)(HINT),
    )
  }

  function setProgress(next: number) {
    progress = Math.max(0, Math.min(1, next))
    const style = STYLES[index]!
    const width = logoWidth(style)
    const ramp = rowRamp(style.lines.length)
    style.lines.forEach((line, row) => {
      const target = rows[row]
      if (target) target.content = revealRow(line, ramp[row]!, width, progress)
    })
  }

  paint()

  return {
    setStyle(id) {
      const next = STYLES.findIndex((style) => style.id === id)
      if (next >= 0) index = next
      paint()
    },
    setProgress,
    current: () => STYLES[index]!,
    /**
     * Detaches the animated rows. The frame itself is left alone on purpose:
     * `Box()` returns a vnode descriptor rather than a renderable, so there is
     * nothing to remove it with, and the renderer that owns it is destroyed
     * right after this in both callers.
     */
    destroy() {
      for (const row of rows) stage.remove(row)
      rows = []
    },
  }
}

// ---------------------------------------------------------------------------
// interactive app
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--capture")) {
    for (const style of STYLES) console.log(plainFrame(style) + "\n")
    return
  }
  if (args.includes("--production")) {
    console.log(productionLogo(""))
    return
  }
  const sheet = args.find((arg) => arg.startsWith("--html="))?.slice("--html=".length)
  if (sheet) {
    await Bun.write(sheet, htmlSheet())
    console.log(`wrote ${STYLES.length} styles to ${sheet}`)
    return
  }

  const requested = args.find((arg) => arg.startsWith("--style="))?.slice("--style=".length)

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: false,
    backgroundColor: BG,
  })
  renderer.setTerminalTitle("nikcli logo lab")

  const view = mountLab(renderer, requested ?? DEFAULT_STYLE_ID)
  let timer: ReturnType<typeof setInterval> | undefined

  function animate() {
    if (timer) clearInterval(timer)
    const started = Date.now()
    timer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - started) / REVEAL_MS)
      view.setProgress(progress)
      if (progress >= 1 && timer) {
        clearInterval(timer)
        timer = undefined
      }
    }, 1000 / 60)
  }

  function cycle(delta: number) {
    const index = STYLES.findIndex((style) => style.id === view.current().id)
    const next = (index + delta + STYLES.length) % STYLES.length
    view.setStyle(STYLES[next]!.id)
    animate()
  }

  renderer.keyInput.on("keypress", (event: KeyEvent) => {
    switch (event.name) {
      case "q":
      case "escape":
        return renderer.destroy()
      case "right":
      case "l":
      case "tab":
        return cycle(1)
      case "left":
      case "h":
        return cycle(-1)
      case "r":
        return animate()
    }
    const digit = Number(event.name)
    if (Number.isInteger(digit) && digit >= 1 && digit <= STYLES.length) {
      view.setStyle(STYLES[digit - 1]!.id)
      animate()
    }
  })

  renderer.on("destroy", () => {
    if (timer) clearInterval(timer)
  })

  view.setProgress(0)
  animate()
}

if (import.meta.main) await main()
