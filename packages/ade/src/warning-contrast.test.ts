import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * `--ade-warning` was used by decisions and design without ever being defined,
 * so every theme painted the fallback #b7791f: 3.6:1 on the light sheet, 4.1:1
 * on the dark one. These tests hold the token to WCAG AA — 4.5:1 as text, 3:1
 * as a border — on the backgrounds it actually sits on, in all three themes.
 */
const css = readFileSync(join(import.meta.dir, "index.css"), "utf8")

type Rgb = [number, number, number]

const hex = (value: string): Rgb => {
  const digits = value.replace("#", "")
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)) as Rgb
}

/** Relative luminance (WCAG 2.x). */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/** A translucent colour laid over what is behind it. */
const over = (rgb: Rgb, alpha: number, behind: Rgb): Rgb =>
  rgb.map((channel, i) => Math.round(channel * alpha + behind[i] * (1 - alpha))) as Rgb

/** The light and dark halves of a `light-dark(#…, #…)` token in index.css. */
function lightDark(token: string): { light: Rgb; dark: Rgb } | undefined {
  const match = css.match(new RegExp(`${token}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`))
  return match ? { light: hex(match[1]), dark: hex(match[2]) } : undefined
}

const TEXT = 4.5
const BORDER = 3

describe("--ade-warning reads on every theme (audit 0.7.7, MEDIO 17)", () => {
  test("the token is defined, one colour per scheme", () => {
    expect(lightDark("--ade-warning")).toBeDefined()
  })

  test("the helpers measure what WCAG says: black on white is 21, the old fallback fails on white", () => {
    expect(contrast(hex("#000000"), hex("#ffffff"))).toBeCloseTo(21, 5)
    expect(contrast(hex("#b7791f"), hex("#ffffff"))).toBeLessThan(TEXT)
  })

  const backgrounds = () => {
    const overlay = lightDark("--ade-overlay")!
    const surface = lightDark("--ade-surface")!
    const glassOverlay = css.match(/--ade-overlay:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)!
    const glass: Rgb = [Number(glassOverlay[1]), Number(glassOverlay[2]), Number(glassOverlay[3])]
    const alpha = Number(glassOverlay[4])
    return {
      "light overlay": [overlay.light, "light"],
      "light surface": [surface.light, "light"],
      "dark overlay": [overlay.dark, "dark"],
      "dark surface": [surface.dark, "dark"],
      // Glass is a dark scheme over whatever desktop is behind: the worst case is white.
      "glass overlay on a white desktop": [over(glass, alpha, [255, 255, 255]), "dark"],
      "glass overlay on a black desktop": [over(glass, alpha, [0, 0, 0]), "dark"],
    } as Record<string, [Rgb, "light" | "dark"]>
  }

  test("as text: at least 4.5:1", () => {
    const warning = lightDark("--ade-warning")!
    for (const [name, [ground, scheme]] of Object.entries(backgrounds())) {
      expect({ name, ratio: contrast(warning[scheme], ground) >= TEXT }).toEqual({ name, ratio: true })
    }
  })

  test("as a border: at least 3:1", () => {
    const warning = lightDark("--ade-warning")!
    for (const [name, [ground, scheme]] of Object.entries(backgrounds())) {
      expect({ name, ratio: contrast(warning[scheme], ground) >= BORDER }).toEqual({ name, ratio: true })
    }
  })
})
