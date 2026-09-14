import { describe, expect, test } from "bun:test"
import { DEFAULT_THEMES } from "./default-themes"
import { resolveTheme, resolveThemeVariant, themeToCss } from "./resolve"

const themes = Object.entries(DEFAULT_THEMES)

// Every token has to be something CSS can paint: a hex colour (3/4/6/8 digits —
// theme JSON may hand back shorthand, and the generated diff surfaces carry an
// alpha pair), an rgba() triple, or a reference to another custom property.
const VALUE = /^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba\(\d+, \d+, \d+, [\d.]+\)|var\(--[a-z0-9-]+\))$/

describe("default themes", () => {
  test("ship at least one theme", () => {
    expect(themes.length).toBeGreaterThan(0)
  })

  test.each(themes)("%s resolves both variants to paintable tokens", (_id, theme) => {
    const resolved = resolveTheme(theme)
    for (const variant of [resolved.light, resolved.dark]) {
      const tokens = Object.entries(variant)
      expect(tokens.length).toBeGreaterThan(0)
      for (const [token, value] of tokens) {
        expect(`${token}=${value}`).toMatch(new RegExp(`^${token}=${VALUE.source.slice(1, -1)}$`))
      }
    }
  })

  test.each(themes)("%s resolves the same token set for light and dark", (_id, theme) => {
    const { light, dark } = resolveTheme(theme)
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort())
  })
})

describe("resolveThemeVariant", () => {
  const theme = DEFAULT_THEMES[Object.keys(DEFAULT_THEMES)[0]]

  test("is deterministic", () => {
    expect(resolveThemeVariant(theme.dark, true)).toEqual(resolveThemeVariant(theme.dark, true))
  })

  test("dark and light backgrounds sit on opposite ends", () => {
    const light = resolveThemeVariant(theme.light, false)
    const dark = resolveThemeVariant(theme.dark, true)
    expect(light["background-base"]).not.toBe(dark["background-base"])
  })

  test("overrides win over generated tokens", () => {
    const base = resolveThemeVariant(theme.light, false)
    const token = Object.keys(base)[0]
    const overridden = resolveThemeVariant(
      { ...theme.light, overrides: { ...theme.light.overrides, [token]: "#123456" } },
      false,
    )
    expect(overridden[token]).toBe("#123456")
  })
})

describe("themeToCss", () => {
  test("emits one custom property declaration per token", () => {
    const css = themeToCss({ "background-base": "#ffffff", "text-base": "#000000" })
    expect(css).toBe("--background-base: #ffffff;\n  --text-base: #000000;")
  })

  test("every declaration of a real theme parses as --name: value;", () => {
    const css = themeToCss(resolveThemeVariant(DEFAULT_THEMES[Object.keys(DEFAULT_THEMES)[0]].dark, true))
    for (const line of css.split("\n").map((entry) => entry.trim())) {
      expect(line).toMatch(/^--[a-z0-9-]+: .+;$/)
    }
  })
})
