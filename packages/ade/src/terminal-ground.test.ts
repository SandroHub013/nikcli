import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * DS-3 (2026-11-02 audit), the user's choice A «Fondi della palette»: the
 * terminal sits on the palette's own grounds, panna #fffaf0 in light and the
 * sunken ink #0d0908 in dark, instead of a cold #fdfcfc and a neutral #0e0c0c.
 * Light tiles no longer flash from crema to white when a transcript swaps to
 * the live terminal, and what an agent reads through OSC 11 is a palette value.
 *
 * Every ANSI colour is measured on both grounds here. Text is held to 4.5:1;
 * `black` is the one exception (below).
 */
const dir = import.meta.dir
const css = readFileSync(join(dir, "index.css"), "utf8")
const pane = readFileSync(join(dir, "grid/pane.css"), "utf8")
const registry = readFileSync(join(dir, "terminal/registry.ts"), "utf8")

type Rgb = [number, number, number]
const hex = (value: string): Rgb => [0, 2, 4].map((i) => parseInt(value.slice(1 + i, 3 + i), 16)) as Rgb
const channel = (c: number) => {
  const x = c / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

function token(name: string): { light: string; dark: string } {
  const match = new RegExp(`${name}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`).exec(css)
  if (!match) throw new Error(`${name} not found as light-dark(#…, #…) in index.css`)
  return { light: match[1]!.toLowerCase(), dark: match[2]!.toLowerCase() }
}

const GROUND = token("--ade-terminal-bg")
const SLOTS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const

/**
 * ANSI black is a cell *background* far more than it is text (status bars,
 * diff gutters, selected rows): it has to stay close to the ground to read as
 * a quiet tint, so on dark it cannot reach 4.5:1 as text. xterm's
 * minimumContrastRatio (4.5, set in registry.ts) lifts it whenever it is used
 * for text, so the token is held to 4.5:1 on light, where it is a real ink, and
 * 2:1 on dark, where it is a tint.
 */
const FLOOR: Record<string, { light: number; dark: number }> = { black: { light: 4.5, dark: 2 } }

describe("the terminal ground is the palette's (DS-3)", () => {
  test("panna in light, the sunken ink in dark", () => {
    expect(GROUND).toEqual({ light: "#fffaf0", dark: "#0d0908" })
  })

  test("the sunken ink is the one the chrome uses", () => {
    expect(token("--ade-sunken").dark).toBe(GROUND.dark)
    expect(token("--ade-raised").light).toBe(GROUND.light)
  })

  test("the terminal text is ink on panna and crema on ink", () => {
    expect(token("--ade-terminal-fg")).toEqual({ light: "#120d0b", dark: "#f4e7cd" })
    expect(contrast(hex(token("--ade-terminal-fg").light), hex(GROUND.light))).toBeGreaterThan(15)
    expect(contrast(hex(token("--ade-terminal-fg").dark), hex(GROUND.dark))).toBeGreaterThan(15)
  })

  test("the transcript is on the terminal's ground, so the swap does not flash", () => {
    const rule = /\[data-slot="pane-transcript"\]\s*\{([^}]*)\}/.exec(pane.replace(/\/\*[\s\S]*?\*\//g, ""))
    expect(rule?.[1]).toMatch(/background:\s*var\(--ade-terminal-bg/)
  })

  test("the terminal reads its ground and its selection from tokens, not from literals", () => {
    const code = registry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(code).not.toMatch(/rgba\(\s*232/)
    expect(code).toMatch(/slot\("background",\s*"--ade-terminal-bg"/)
    expect(code).toMatch(/slot\("foreground",\s*"--ade-terminal-fg"/)
  })
})

describe("every ANSI colour on both terminal grounds (DS-3)", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const name of SLOTS) {
      const floor = FLOOR[name]?.[scheme] ?? 4.5
      test(`${scheme} ${name} on the ground is at least ${floor}:1`, () => {
        const ratio = contrast(hex(token(`--ade-ansi-${name}`)[scheme]), hex(GROUND[scheme]))
        expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(floor)
      })
    }
  }
})
