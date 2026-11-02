import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * The colour pairs the session-state work added or moved (DS-1, DS-22).
 *
 * `palette-ragu.test.ts` measures the five grounds and the tokens on them.
 * These are the pairs it cannot see: the state colours as marks (3:1) and as the
 * chip's word on its own tint (4.5:1), and a veil composited over `raised`,
 * which is what a selected sidebar row really sits on.
 */

const css = readFileSync(join(import.meta.dir, "index.css"), "utf-8")

type Rgb = [number, number, number]
type Scheme = "light" | "dark"
const SCHEMES: Scheme[] = ["light", "dark"]

const hex = (value: string): Rgb => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as Rgb
const channel = (c: number) => {
  const x = c / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
/** `over` painted at `alpha` on `under`, in sRGB like the browser's alpha blend. */
const over = (top: Rgb, alpha: number, under: Rgb): Rgb => top.map((v, i) => Math.round(v * alpha + under[i]! * (1 - alpha))) as Rgb

function token(name: string): Record<Scheme, Rgb> {
  const match = new RegExp(`${name}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`).exec(css)
  if (!match) throw new Error(`${name} not found as light-dark(#…, #…) in index.css`)
  return { light: hex(match[1]!), dark: hex(match[2]!) }
}

function veil(name: string): Record<Scheme, { rgb: Rgb; alpha: number }> {
  const match = new RegExp(
    `${name}:\\s*light-dark\\(rgba\\((\\d+), (\\d+), (\\d+), ([\\d.]+)\\),\\s*rgba\\((\\d+), (\\d+), (\\d+), ([\\d.]+)\\)\\)`,
  ).exec(css)
  if (!match) throw new Error(`${name} not found as light-dark(rgba(…), rgba(…)) in index.css`)
  return {
    light: { rgb: [Number(match[1]), Number(match[2]), Number(match[3])], alpha: Number(match[4]) },
    dark: { rgb: [Number(match[5]), Number(match[6]), Number(match[7])], alpha: Number(match[8]) },
  }
}

/** What each `--ade-state-*` resolves to (index.css), by the token it names. */
function stateColour(id: string, scheme: Scheme): Rgb {
  const value = new RegExp(`--ade-state-${id}:\\s*([^;]+);`).exec(css)?.[1]
  if (!value) throw new Error(`--ade-state-${id} not found`)
  const mix = /^color-mix\(in srgb, var\((--[a-z-]+)\) (\d+)%, var\((--[a-z-]+)\)\)$/.exec(value)
  if (mix) return over(token(mix[1]!)[scheme], Number(mix[2]) / 100, token(mix[3]!)[scheme])
  const reference = /^var\((--[a-z-]+)\)$/.exec(value)
  if (!reference) throw new Error(`--ade-state-${id}: ${value} is neither var() nor color-mix()`)
  return token(reference[1]!)[scheme]
}

const IDS = ["work", "perm", "ask", "err", "limit", "idle", "off", "closed"]
const GROUNDS = ["--ade-sunken", "--ade-bg", "--ade-surface", "--ade-raised", "--ade-overlay"]

describe("the state colours are legible marks on every ground (3:1)", () => {
  for (const scheme of SCHEMES) {
    test(scheme, () => {
      const rows = IDS.flatMap((id) =>
        GROUNDS.map((ground) => ({
          pair: `${scheme} ${id} on ${ground}`,
          ratio: Number(contrast(stateColour(id, scheme), token(ground)[scheme]).toFixed(2)),
        })),
      )
      expect(rows.filter((row) => row.ratio < 3)).toEqual([])
    })
  }
})

describe("the chip's state word on its own tint (4.5:1)", () => {
  /*
   * The chip is `--st` at 10% over the pill's ground (a crema step in light, `raised` in
   * dark). At 14% the light «Al lavoro» and «Permesso» measured 4.45 and 4.40.
   */
  for (const scheme of SCHEMES) {
    test(scheme, () => {
      const ground = token(scheme === "light" ? "--ade-surface" : "--ade-raised")[scheme]
      const rows = IDS.map((id) => {
        const colour = stateColour(id, scheme)
        return { pair: `${scheme} ${id}`, ratio: Number(contrast(colour, over(colour, 0.1, ground)).toFixed(2)) }
      })
      expect(rows.filter((row) => row.ratio < 4.5)).toEqual([])
    })
  }
})

describe("a selected sidebar row's meta line (DS-22)", () => {
  const selection = veil("--ade-accent-soft")

  for (const scheme of SCHEMES) {
    test(`${scheme}: the soft text reads on the selection's veil over raised`, () => {
      const ground = over(selection[scheme].rgb, selection[scheme].alpha, token("--ade-raised")[scheme])
      expect(contrast(token("--ade-text-soft")[scheme], ground)).toBeGreaterThanOrEqual(4.5)
    })
  }

  test("dark: the weak text did not, which is why the selected row takes the soft one", () => {
    const ground = over(selection.dark.rgb, selection.dark.alpha, token("--ade-raised").dark)
    expect(contrast(token("--ade-text-weak").dark, ground)).toBeLessThan(4.5)
  })
})
