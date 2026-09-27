import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * The text on a full brand fill, in light and in dark (polish-aaa B6): the
 * brand colour stays the vendor's, the text on it clears AA.
 */

const css = readFileSync(join(import.meta.dir, "session-new.css"), "utf-8")

type Rgb = [number, number, number]

const hex = (value: string): Rgb => {
  const h = value.replace("#", "")
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
}

function contrast(a: Rgb, b: Rgb): number {
  const lum = ([r, g, b]: Rgb) =>
    [r, g, b]
      .map((c) => c / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
      .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i]!, 0)
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** A token's light and dark value: `light-dark(#a, #b)` or one `#c` for both. */
function pair(block: string, token: string): { light: Rgb; dark: Rgb } {
  const value = new RegExp(`${token}:\\s*([^;]+);`).exec(block)?.[1]?.trim()
  if (!value) throw new Error(`${token} missing`)
  const both = /light-dark\((#[0-9a-fA-F]{6}),\s*(#[0-9a-fA-F]{6})\)/.exec(value)
  if (both) return { light: hex(both[1]!), dark: hex(both[2]!) }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return { light: hex(value), dark: hex(value) }
  throw new Error(`${token}: ${value} is not a colour this test reads`)
}

const blocks = [...css.matchAll(/((?:\[data-agent-id="[^"]+"\],?\s*)+)\{([^}]*--cli-contrast[^}]*)\}/g)]

test("every brand tile declares its text colour", () => {
  expect(blocks.length).toBeGreaterThanOrEqual(9)
})

test("the text on each brand fill clears 4.5:1 in light and in dark", () => {
  const under: string[] = []
  for (const [, selector, body] of blocks) {
    const color = pair(body!, "--cli-color")
    const text = pair(body!, "--cli-contrast")
    for (const scheme of ["light", "dark"] as const) {
      const ratio = contrast(color[scheme], text[scheme])
      if (ratio < 4.5) under.push(`${selector!.trim()} ${scheme} ${ratio.toFixed(2)}`)
    }
  }
  expect(under).toEqual([])
})

test("the brand colours are the vendors' and did not move", () => {
  const claude = blocks.find(([, selector]) => selector!.includes('"claude-code"'))!
  expect(pair(claude[2]!, "--cli-color")).toEqual({ light: hex("#c25a39"), dark: hex("#d97757") })
})
