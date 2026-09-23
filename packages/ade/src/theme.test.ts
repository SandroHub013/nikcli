import { describe, expect, test } from "bun:test"
import { parseTheme, resolveTheme, serializeTheme } from "./theme"
import type { Theme } from "./theme"

describe("resolveTheme", () => {
  test("explicit dark ignores system preference", () => {
    expect(resolveTheme("dark", false)).toBe("dark")
    expect(resolveTheme("dark", true)).toBe("dark")
  })

  test("explicit light ignores system preference", () => {
    expect(resolveTheme("light", false)).toBe("light")
    expect(resolveTheme("light", true)).toBe("light")
  })

  test("system follows OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark")
    expect(resolveTheme("system", false)).toBe("light")
  })

  test("undefined falls back to system behaviour", () => {
    expect(resolveTheme(undefined, true)).toBe("dark")
    expect(resolveTheme(undefined, false)).toBe("light")
  })

  test("null falls back to system behaviour", () => {
    expect(resolveTheme(null, true)).toBe("dark")
    expect(resolveTheme(null, false)).toBe("light")
  })
  test("explicit glass ignores system preference", () => {
    expect(resolveTheme("glass", false)).toBe("glass")
    expect(resolveTheme("glass", true)).toBe("glass")
  })
})

describe("parseTheme", () => {
  test("recognises canonical values", () => {
    expect(parseTheme("dark")).toBe("dark")
    expect(parseTheme("light")).toBe("light")
    expect(parseTheme("glass")).toBe("glass")
    expect(parseTheme("system")).toBe("system")
  })

  test("is case-insensitive and trims whitespace", () => {
    expect(parseTheme("  Dark ")).toBe("dark")
    expect(parseTheme("LIGHT")).toBe("light")
    expect(parseTheme("  GLASS  ")).toBe("glass")
    expect(parseTheme(" System")).toBe("system")
  })

  test("returns system for garbage input", () => {
    expect(parseTheme("nope")).toBe("system")
    expect(parseTheme("")).toBe("system")
    expect(parseTheme("  ")).toBe("system")
  })

  test("returns system for null and undefined", () => {
    expect(parseTheme(null)).toBe("system")
    expect(parseTheme(undefined)).toBe("system")
  })
})

describe("serializeTheme", () => {
  test("round-trips through parse", () => {
    const values: Theme[] = ["dark", "light", "glass", "system"]
    for (const v of values) {
      expect(parseTheme(serializeTheme(v))).toBe(v)
    }
  })

  test("returns the canonical string", () => {
    expect(serializeTheme("dark")).toBe("dark")
    expect(serializeTheme("light")).toBe("light")
    expect(serializeTheme("glass")).toBe("glass")
    expect(serializeTheme("system")).toBe("system")
  })
})

describe("glass opacity helpers", () => {
  test("clampGlassOpacity clamps to 0-100", () => {
    const { clampGlassOpacity, DEFAULT_GLASS_OPACITY } = require("./theme")
    expect(clampGlassOpacity(50)).toBe(50)
    expect(clampGlassOpacity(-10)).toBe(0)
    expect(clampGlassOpacity(150)).toBe(100)
    expect(clampGlassOpacity(NaN)).toBe(DEFAULT_GLASS_OPACITY)
  })

  test("parseGlassOpacity parses string values tolerantly", () => {
    const { parseGlassOpacity, DEFAULT_GLASS_OPACITY } = require("./theme")
    expect(parseGlassOpacity("80")).toBe(80)
    expect(parseGlassOpacity("0")).toBe(0)
    expect(parseGlassOpacity("100")).toBe(100)
    expect(parseGlassOpacity(null)).toBe(DEFAULT_GLASS_OPACITY)
    expect(parseGlassOpacity(undefined)).toBe(DEFAULT_GLASS_OPACITY)
    expect(parseGlassOpacity("invalid")).toBe(DEFAULT_GLASS_OPACITY)
  })

  test("THEME_CHOICES contains all options", () => {
    const { THEME_CHOICES } = require("./theme")
    expect(THEME_CHOICES).toEqual(["light", "dark", "glass", "system"])
  })
})
