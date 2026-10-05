import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * The text tokens against the grounds they sit on, read from index.css (polish-aaa B6).
 *
 * Piece 0 measured the sheet's counter, meta and option details under AA:
 * 3.51 and 3.69 in light, 4.40 in dark. All three are `--ade-text-weak`, so
 * the floor belongs to the token: every text step, on every ground, in every
 * theme, at least 4.5:1.
 */

const css = readFileSync(join(import.meta.dir, "index.css"), "utf-8")

type Rgb = [number, number, number]

function hex(value: string): Rgb {
  const h = value.replace("#", "")
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** `rgba` over an opaque ground. */
function over(top: [number, number, number, number], ground: Rgb): Rgb {
  const [r, g, b, a] = top
  return [r * a + ground[0] * (1 - a), g * a + ground[1] * (1 - a), b * a + ground[2] * (1 - a)]
}

/** The two values of a `light-dark()` token in the shared block. */
function lightDark(token: string): { light: Rgb; dark: Rgb } {
  const match = new RegExp(`${token}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`).exec(css)
  if (!match) throw new Error(`${token} not found as light-dark() in index.css`)
  return { light: hex(match[1]!), dark: hex(match[2]!) }
}

/** A token's value in the glass block. */
function glass(token: string): string {
  const block = css.slice(css.indexOf('[data-component="ade-shell"][data-theme="glass"],'))
  const match = new RegExp(`${token}:\\s*([^;]+);`).exec(block)
  if (!match) throw new Error(`${token} not found in the glass block`)
  return match[1]!.trim()
}

function rgba(value: string): [number, number, number, number] {
  const match = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(value)
  if (!match) throw new Error(`not an rgba(): ${value}`)
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
}

const TEXT = ["--ade-text", "--ade-text-soft", "--ade-text-weak"] as const
const GROUNDS = ["--ade-bg", "--ade-surface", "--ade-raised", "--ade-overlay"] as const

describe("text contrast of the tokens (AA, 4.5:1)", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme}: every text step on every ground`, () => {
      for (const text of TEXT) {
        for (const ground of GROUNDS) {
          const ratio = contrast(lightDark(text)[scheme], lightDark(ground)[scheme])
          expect({ text, ground, ok: ratio >= 4.5 }).toEqual({ text, ground, ok: true })
        }
      }
    })

    test(`${scheme}: soft stays a step above weak on every ground`, () => {
      for (const ground of GROUNDS) {
        const g = lightDark(ground)[scheme]
        expect(contrast(lightDark("--ade-text-soft")[scheme], g)).toBeGreaterThan(
          contrast(lightDark("--ade-text-weak")[scheme], g),
        )
      }
    })
  }

  test("glass: every text step on the overlay and on the reading ground, over a white desktop", () => {
    const white: Rgb = [255, 255, 255]
    const overlay = over(rgba(glass("--ade-overlay")), white)
    // The reading ground at the default slider (75%), with the raised lift on it: the brightest ground in the theme.
    const read = 0.05 + 0.85 * 0.75 ** 0.24
    const reading = over([255, 255, 255, 0.06], over([19, 17, 17, read], white))
    for (const text of TEXT) {
      const color = hex(glass(text))
      expect({ text, overlay: contrast(color, overlay) >= 4.5, reading: contrast(color, reading) >= 4.5 }).toEqual({
        text,
        overlay: true,
        reading: true,
      })
    }
  })

  test("the three values piece 0 measured under AA are over it now", () => {
    const weak = lightDark("--ade-text-weak")
    // Option details on surface, meta and the counter on overlay (light); the counter on overlay (dark).
    expect(contrast(weak.light, lightDark("--ade-surface").light)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(weak.light, lightDark("--ade-overlay").light)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(weak.dark, lightDark("--ade-overlay").dark)).toBeGreaterThanOrEqual(4.5)
  })
})

describe("the words on a solid ink fill (the chosen value, the primary action)", () => {
  // `background: var(--ade-text); color: var(--ade-on-ink)` is the pair every ink fill uses.
  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme}: on-ink on the ink fill`, () => {
      expect(css).toMatch(/--ade-on-ink:\s*var\(--ade-bg\);/)
      expect(contrast(lightDark("--ade-bg")[scheme], lightDark("--ade-text")[scheme])).toBeGreaterThanOrEqual(4.5)
    })
  }

  test("glass: on-ink is a solid colour and reads on the white ink fill", () => {
    const ground = /--ade-glass-ground:\s*(#[0-9a-fA-F]{6});/.exec(css)?.[1]
    expect(glass("--ade-on-ink")).toBe("var(--ade-glass-ground)")
    expect(ground).toBeDefined()
    expect(contrast(hex(ground!), hex(glass("--ade-text")))).toBeGreaterThanOrEqual(4.5)
  })
})

describe("no text colour resolves to transparent", () => {
  // In glass the containers' grounds are `transparent`: as a `color` they paint nothing (white on white, 1.00:1).
  const block = css.slice(css.indexOf('[data-component="ade-shell"][data-theme="glass"],'))
  const clear = [...block.matchAll(/(--ade-[a-z-]+):\s*transparent;/g)].map((m) => m[1]!)

  function stylesheets(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : stylesheets(path)
      return entry.name.endsWith(".css") ? [path] : []
    })
  }

  test("the glass block does clear the grounds this test looks for", () => {
    expect(clear).toContain("--ade-bg")
    expect(clear).toContain("--ade-surface")
  })

  test("no `color:` in any stylesheet is a token that glass makes transparent", () => {
    const offenders: string[] = []
    for (const file of stylesheets(import.meta.dir)) {
      const lines = readFileSync(file, "utf-8").split(/\r?\n/)
      lines.forEach((line, i) => {
        const match = /(?<![-\w])color:\s*var\((--ade-[a-z-]+)\)/.exec(line)
        if (match && clear.includes(match[1]!))
          offenders.push(`${file.slice(import.meta.dir.length + 1)}:${i + 1} ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
