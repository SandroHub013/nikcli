import { describe, expect, test } from "bun:test"
import type { HexColor } from "./types"
import {
  darken,
  generateAlphaScale,
  generateNeutralScale,
  generateScale,
  hexToOklch,
  hexToRgb,
  lighten,
  mixColors,
  oklchToHex,
  rgbToHex,
  withAlpha,
} from "./color"

const SEEDS: HexColor[] = ["#000000", "#ffffff", "#7c3aed", "#22c55e", "#f59e0b", "#ef4444", "#1e3a5f"]

describe("hex <-> rgb", () => {
  test("expands three-digit shorthand", () => {
    expect(hexToRgb("#fff")).toEqual(hexToRgb("#ffffff"))
    expect(hexToRgb("#f00")).toEqual({ r: 1, g: 0, b: 0 })
  })

  test("round-trips every seed", () => {
    for (const seed of SEEDS) {
      const { r, g, b } = hexToRgb(seed)
      expect(rgbToHex(r, g, b)).toBe(seed)
    }
  })

  test("clamps out-of-gamut channels instead of emitting short hex", () => {
    expect(rgbToHex(2, -1, 0.5)).toBe("#ff0080")
  })
})

describe("hex <-> oklch", () => {
  test("round-trips within one 8-bit step", () => {
    for (const seed of SEEDS) {
      const back = hexToRgb(oklchToHex(hexToOklch(seed)))
      const original = hexToRgb(seed)
      for (const channel of ["r", "g", "b"] as const) {
        expect(Math.abs(back[channel] - original[channel])).toBeLessThanOrEqual(1 / 255)
      }
    }
  })

  test("greys carry no chroma", () => {
    expect(hexToOklch("#808080").c).toBeCloseTo(0, 5)
  })

  test("lightness tracks brightness", () => {
    expect(hexToOklch("#000000").l).toBeCloseTo(0, 5)
    expect(hexToOklch("#ffffff").l).toBeCloseTo(1, 5)
  })
})

describe("scales", () => {
  test("generateScale emits twelve valid steps for both schemes", () => {
    for (const seed of SEEDS) {
      for (const isDark of [false, true]) {
        const scale = generateScale(seed, isDark)
        expect(scale).toHaveLength(12)
        for (const step of scale) expect(step).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  test("light scale runs light-to-dark, dark scale runs dark-to-light", () => {
    const light = generateScale("#7c3aed", false).map((hex) => hexToOklch(hex).l)
    const dark = generateScale("#7c3aed", true).map((hex) => hexToOklch(hex).l)
    expect(light[0]).toBeGreaterThan(light[11])
    expect(dark[0]).toBeLessThan(dark[11])
  })

  test("generateNeutralScale caps chroma so seeds stay grey", () => {
    // The cap is 0.02; quantising each step to 8-bit hex can nudge it slightly past that.
    for (const step of generateNeutralScale("#7c3aed", false)) {
      expect(hexToOklch(step).c).toBeLessThan(0.025)
    }
  })

  test("generateAlphaScale flattens against the scheme background", () => {
    const scale = generateScale("#7c3aed", false)
    const flattened = generateAlphaScale(scale, false)
    expect(flattened).toHaveLength(12)
    // The lowest alpha step sits almost on the white page background.
    expect(hexToOklch(flattened[0]).l).toBeGreaterThan(0.95)
  })
})

describe("manipulation", () => {
  test("mixColors interpolates between the endpoints", () => {
    expect(mixColors("#000000", "#ffffff", 0)).toBe("#000000")
    expect(mixColors("#000000", "#ffffff", 1)).toBe("#ffffff")
    const mid = hexToOklch(mixColors("#000000", "#ffffff", 0.5)).l
    expect(mid).toBeGreaterThan(0.4)
    expect(mid).toBeLessThan(0.6)
  })

  test("lighten and darken move lightness and clamp at the ends", () => {
    expect(hexToOklch(lighten("#7c3aed", 0.1)).l).toBeGreaterThan(hexToOklch("#7c3aed").l)
    expect(hexToOklch(darken("#7c3aed", 0.1)).l).toBeLessThan(hexToOklch("#7c3aed").l)
    expect(lighten("#ffffff", 0.5)).toBe("#ffffff")
    expect(darken("#000000", 0.5)).toBe("#000000")
  })

  test("withAlpha emits 0-255 rgba channels", () => {
    expect(withAlpha("#7c3aed", 0.3)).toBe("rgba(124, 58, 237, 0.3)")
  })
})
