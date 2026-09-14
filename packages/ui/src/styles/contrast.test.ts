import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { DesktopTheme } from "../theme/types"
import { resolveThemeVariant } from "../theme/resolve"

/**
 * Text tokens have to be legible against the surface they sit on.
 *
 * Measured in the running app, the empty-state heading came out at 1.87:1 — it
 * was painted with `--text-weaker`, the token meant for de-emphasis, which fails
 * WCAG AA for any text at all.
 *
 * Resolved through the loader's default theme (nikcli-default.json) rather than
 * only stylesheet fallbacks. An earlier version of this file read
 * `--smoke-light-11` directly from palette primitives, which checked that the
 * paint tin had the right colour in it, not that the wall was painted with it.
 * A later version read theme.css directly, which missed that the runtime theme
 * loader injects resolved JSON tokens into `:root` after the stylesheet.
 * We resolve tokens with the loader's exact precedence: nikcli-default.json
 * (seeds + overrides) -> theme.css -> colors.css palette primitives.
 */
const palette = readFileSync(new URL("./colors.css", import.meta.url), "utf8")
const theme = readFileSync(new URL("./theme.css", import.meta.url), "utf8")
const defaultTheme: DesktopTheme = JSON.parse(
  readFileSync(new URL("../theme/themes/nikcli-default.json", import.meta.url), "utf8"),
)

const lightTokens = resolveThemeVariant(defaultTheme.light, false)
const darkTokens = resolveThemeVariant(defaultTheme.dark, true)

/**
 * A custom property's definition from a CSS source string.
 *
 * `which: "dark"` reads the one inside `@media (prefers-color-scheme: dark)`.
 * If not defined in the dark block, it falls back to the `:root` light block
 * as standard CSS cascade rules dictate.
 */
function declaration(source: string, name: string, which: "light" | "dark" = "light"): string {
  const darkAt = source.indexOf("@media (prefers-color-scheme: dark)")
  const scope =
    which === "dark" && darkAt >= 0 ? source.slice(darkAt) : source.slice(0, darkAt >= 0 ? darkAt : undefined)
  const match = scope.match(new RegExp(`--${name}:\\s*([^;]+);`))
  if (match) return match[1]!.trim()
  if (which === "dark" && darkAt >= 0) {
    const lightScope = source.slice(0, darkAt)
    const lightMatch = lightScope.match(new RegExp(`--${name}:\\s*([^;]+);`))
    if (lightMatch) return lightMatch[1]!.trim()
  }
  throw new Error(`no ${which} definition of --${name}`)
}

/**
 * Get the raw declaration of a token, matching the theme loader's precedence:
 * 1. Default theme tokens generated/overridden in nikcli-default.json (injected into :root after stylesheet)
 * 2. Pre-theme fallback definitions in theme.css
 * 3. Palette primitives in colors.css
 */
function getRaw(name: string, which: "light" | "dark" = "light"): string {
  const tokens = which === "dark" ? darkTokens : lightTokens
  if (tokens[name] !== undefined) {
    return tokens[name]
  }
  const from = theme.includes(`--${name}:`) ? theme : palette
  return declaration(from, name, which)
}

/** Follow `var(--x)` indirection until a literal colour is reached. */
function resolve(name: string, which: "light" | "dark" = "light"): string {
  let value = getRaw(name, which)
  for (let hop = 0; hop < 8; hop++) {
    const indirect = value.match(/^var\(--([a-z0-9-]+)\)$/)
    if (!indirect) break
    const next = indirect[1]!
    value = getRaw(next, which)
  }
  if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) {
    throw new Error(`--${name} resolved to ${value}, which is not a hex colour`)
  }
  return value
}

/**
 * Flatten an eight-digit hex onto an opaque background.
 *
 * The dark theme paints its text with alpha over the surface, so the ratio has
 * to be taken against what the eye actually sees, not against the unblended
 * colour.
 */
function flatten(colour: string, background: string): string {
  if (colour.length === 7) return colour
  const alpha = Number.parseInt(colour.slice(7, 9), 16) / 255
  const channel = (index: number) => {
    const fg = Number.parseInt(colour.slice(index, index + 2), 16)
    const bg = Number.parseInt(background.slice(index, index + 2), 16)
    return Math.round(fg * alpha + bg * (1 - alpha)).toString(16).padStart(2, "0")
  }
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

function luminance(colour: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(colour.slice(index, index + 2), 16) / 255)
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

export function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter! + 0.05) / (darker! + 0.05)
}

/** What the page is actually painted on, not the raised surfaces above it. */
const SURFACE = resolve("background-base")

describe("contrast maths", () => {
  test("agrees with the known anchors, so the numbers below mean something", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1)
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5)
    // Grey 0x767676 on white is the canonical 4.5:1 boundary.
    expect(contrast("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5)
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.54)
  })
})

describe("light palette", () => {
  test("the surface is the light page background, not a raised layer", () => {
    expect(SURFACE).toBe("#f8f7f7")
    expect(luminance(SURFACE)).toBeGreaterThan(0.8)
  })

  test("the semantic names resolve through to the palette", () => {
    // If this stopped following `var()` the ratios below would be measured
    // against a name rather than a colour, and would throw rather than lie.
    expect(resolve("text-base")).toMatch(/^#[0-9a-f]{6}$/)
    expect(resolve("text-base")).not.toBe(resolve("text-weak"))
  })

  test("body text clears AA", () => {
    // `--text-base`, what ordinary copy is painted with.
    expect(contrast(resolve("text-base"), SURFACE)).toBeGreaterThanOrEqual(4.5)
  })

  test("strong text clears AA comfortably", () => {
    expect(contrast(resolve("text-strong"), SURFACE)).toBeGreaterThanOrEqual(7)
  })

  test("secondary text clears AA too", () => {
    // It did not: `--smoke-light-9` measured 3.2:1 and carried the timestamps,
    // the placeholders and the empty states — 92 places at 11-14px, where AA
    // asks 4.5:1. The token is now the darkest warm grey that clears it.
    expect(contrast(resolve("text-weak"), SURFACE)).toBeGreaterThanOrEqual(4.5)
  })

  test("the tier survives: secondary is still lighter than body text", () => {
    // The point of raising it was legibility, not flattening the palette. If
    // these ever meet, the three-step hierarchy has become two.
    expect(luminance(resolve("text-weak"))).toBeGreaterThan(luminance(resolve("text-base")))
    expect(luminance(resolve("text-base"))).toBeGreaterThan(luminance(resolve("text-strong")))
  })

  test("the de-emphasis token is documented as failing AA, so nothing carries meaning in it", () => {
    // Kept as a measurement rather than an aspiration: this is what it is today,
    // and the test exists so that using it for a heading is a deliberate act.
    const ratio = contrast(resolve("text-weaker"), SURFACE)
    expect(ratio).toBeLessThan(3)
    expect(ratio).toBeGreaterThan(1.5)
  })
})

/**
 * The dark theme, measured the same way.
 *
 * It had never been measured at all: it is selected by a media query, so there
 * is no attribute to flip in a headless browser, and the audit that produced the
 * light-mode numbers silently kept reporting light-mode tokens when asked for
 * dark. Its text tokens carry alpha, so they are flattened onto the background
 * before the ratio is taken.
 */
describe("dark palette", () => {
  const SURFACE_DARK = resolve("background-base", "dark")
  const text = (name: string) => flatten(resolve(name, "dark"), SURFACE_DARK)

  test("the dark surface really is dark, so the numbers below are not light-mode ones", () => {
    expect(luminance(SURFACE_DARK)).toBeLessThan(0.05)
    expect(SURFACE_DARK).not.toBe(SURFACE)
  })

  test("body text clears AA", () => {
    expect(contrast(text("text-base"), SURFACE_DARK)).toBeGreaterThanOrEqual(4.5)
  })

  test("strong text clears AA comfortably", () => {
    expect(contrast(text("text-strong"), SURFACE_DARK)).toBeGreaterThanOrEqual(7)
  })

  test("secondary text clears AA too", () => {
    // Like light mode, `--text-weak` in the resolved theme (#faf5f477) clears
    // the 4.5:1 threshold (4.52:1 measured) when flattened onto the dark surface.
    expect(contrast(text("text-weak"), SURFACE_DARK)).toBeGreaterThanOrEqual(4.5)
  })

  test("the tier survives: secondary is still dimmer than body text", () => {
    // In dark mode, text is painted lighter on a dark ground.
    expect(luminance(text("text-strong"))).toBeGreaterThan(luminance(text("text-base")))
    expect(luminance(text("text-base"))).toBeGreaterThan(luminance(text("text-weak")))
    expect(luminance(text("text-weak"))).toBeGreaterThan(luminance(text("text-weaker")))
  })

  test("the de-emphasis token is documented as failing AA, so nothing carries meaning in it", () => {
    // Both clear the 3:1 large-text bar and miss the 4.5:1 body-text one — a
    // better position than light mode, where de-emphasis measures 1.8:1 and is
    // legible to nobody. Recorded rather than changed: the remedy is a palette
    // decision, and these are the numbers it would be making.
    const weaker = contrast(text("text-weaker"), SURFACE_DARK)
    expect(weaker).toBeGreaterThanOrEqual(3)
    expect(weaker).toBeLessThan(4.5)
    // Dark de-emphasis is not the disaster light de-emphasis is.
    expect(weaker).toBeGreaterThan(contrast(resolve("text-weaker"), SURFACE))
  })
})

