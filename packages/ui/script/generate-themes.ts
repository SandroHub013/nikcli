#!/usr/bin/env bun
/**
 * Generates desktop themes from the canonical TUI/mobile theme JSON so the
 * desktop app offers the same palettes as the rest of the product.
 *
 * - Source: packages/tui/src/context/theme (preferred), then packages/mobile/lib/themes.
 * - Hand-tuned desktop themes (files already in src/theme/themes) are never overwritten.
 * - Output: src/theme/themes/<id>.json plus src/theme/themes.generated.ts.
 *
 * Seeds drive the hue of the generated scales; overrides pin the surfaces, text and
 * borders that define a theme's character to the real palette.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { EXTRA_THEMES, type Palette } from "./extra-themes"

const root = path.resolve(import.meta.dir, "../..")
const sources = [path.join(root, "tui/src/context/theme"), path.join(root, "mobile/lib/themes")]
const out = path.resolve(import.meta.dir, "../src/theme/themes")
const manifest = path.resolve(import.meta.dir, "../src/theme/themes.generated.ts")

type Mode = "dark" | "light"
type Hex = `#${string}`
type Raw = string | { dark?: string; light?: string }
type Source = { defs?: Record<string, Raw>; theme: Record<string, Raw> }

const handTuned = new Set(
  readdirSync(out)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, "")),
)
// Files written by a previous run are regenerated; hand-tuned ones are those not listed in the manifest.
const generatedBefore = existsSync(manifest)
  ? new Set([...readFileSync(manifest, "utf8").matchAll(/"\.\/themes\/([^"]+)\.json"/g)].map((m) => m[1]))
  : new Set<string>()
const protectedIds = new Set([...handTuned].filter((id) => !generatedBefore.has(id)))

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)

function pick(raw: Raw | undefined, mode: Mode, defs: Record<string, Raw>, depth = 0): Hex | undefined {
  if (raw === undefined || depth > 6) return undefined
  const value = typeof raw === "string" ? raw : (raw[mode] ?? raw.dark ?? raw.light)
  if (value === undefined) return undefined
  // Drop any alpha channel: desktop surfaces are composed by the theme resolver.
  if (isHex(value)) return value.slice(0, 7).toLowerCase() as Hex
  if (value in defs) return pick(defs[value], mode, defs, depth + 1)
  return undefined
}

const channel = (hex: Hex, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
function mix(a: Hex, b: Hex, amount: number): Hex {
  const c = [0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * amount))
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

const luminance = (hex: Hex) => {
  const [r, g, b] = [0, 1, 2].map((i) => {
    const v = channel(hex, i) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: Hex, b: Hex) => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** Nudges fg toward the readable pole until it reaches `min` contrast on every background. */
function ensure(fg: Hex, backgrounds: Hex[], min: number): Hex {
  const pole: Hex = luminance(backgrounds[0]) < 0.4 ? "#ffffff" : "#000000"
  for (let step = 0; step <= 20; step++) {
    const candidate = step === 0 ? fg : mix(fg, pole, step / 20)
    if (backgrounds.every((bg) => ratio(candidate, bg) >= min)) return candidate
  }
  return pole
}

type Colors = {
  bg: Hex
  panel: Hex
  element: Hex
  text: Hex
  muted: Hex
  border: Hex
  subtle: Hex
  borderActive?: Hex
  primary: Hex
  success: Hex
  warning: Hex
  error: Hex
  info: Hex
  diffAdd: Hex
  diffDelete: Hex
}

function colorsFromSource(src: Source, mode: Mode): Colors | undefined {
  const defs = src.defs ?? {}
  const get = (key: string) => pick(src.theme[key], mode, defs)
  // Terminal-first themes (liquid-*) declare transparent backgrounds; use their panel tint instead.
  const panelTint = Object.keys(defs).find((k) => k.toLowerCase().startsWith(mode) && /panelbg$/i.test(k))
  const bg = get("background") ?? (panelTint ? pick(defs[panelTint], mode, defs) : undefined)
  const text = get("text")
  if (!bg || !text) return undefined

  const panel = get("backgroundPanel") ?? bg
  const primary = get("primary") ?? text
  const border = get("border") ?? mix(text, bg, 0.8)
  return {
    bg,
    panel,
    element: get("backgroundElement") ?? panel,
    text,
    muted: get("textMuted") ?? mix(text, bg, 0.45),
    border,
    subtle: get("borderSubtle") ?? mix(border, bg, 0.5),
    borderActive: get("borderActive"),
    primary,
    success: get("success") ?? primary,
    warning: get("warning") ?? primary,
    error: get("error") ?? primary,
    info: get("info") ?? primary,
    diffAdd: get("diffAdded") ?? get("success") ?? primary,
    diffDelete: get("diffRemoved") ?? get("error") ?? primary,
  }
}

function colorsFromPalette(p: Palette): Colors {
  const [bg, panel, text, muted, border, primary, success, warning, error, info] = p as unknown as Hex[]
  return {
    bg,
    panel,
    element: mix(bg, text, 0.06),
    text,
    muted,
    border,
    subtle: mix(border, bg, 0.45),
    primary,
    success,
    warning,
    error,
    info,
    diffAdd: success,
    diffDelete: error,
  }
}

/** Light counterpart for a dark-only palette: tinted paper, inked text, accents pushed to readable. */
function deriveLight(dark: Colors): Colors {
  const bg = mix("#ffffff", dark.bg, 0.07)
  const panel: Hex = "#ffffff"
  const text = mix("#000000", dark.bg, 0.72)
  const accent = (c: Hex) => ensure(c, [bg, panel], 3.4)
  const border = mix(bg, "#000000", 0.13)
  return {
    bg,
    panel,
    element: mix(bg, "#000000", 0.04),
    text,
    muted: ensure(mix(text, bg, 0.5), [bg, panel], 3.4),
    border,
    subtle: mix(border, bg, 0.5),
    primary: accent(dark.primary),
    success: accent(dark.success),
    warning: accent(dark.warning),
    error: accent(dark.error),
    info: accent(dark.info),
    diffAdd: accent(dark.diffAdd),
    diffDelete: accent(dark.diffDelete),
  }
}

function build(c: Colors, mode: Mode) {
  const { bg, panel, element, text, muted, border, subtle, primary } = c
  void mode

  const seeds = {
    neutral: bg,
    primary,
    success: c.success,
    warning: c.warning,
    error: c.error,
    info: c.info,
    interactive: primary,
    diffAdd: c.diffAdd,
    diffDelete: c.diffDelete,
  }

  const overrides: Record<string, Hex> = {
    "background-base": bg,
    "background-weak": element,
    "background-strong": bg,
    "background-stronger": panel,
    "surface-raised-stronger-non-alpha": panel,
    "text-strong": ensure(text, [bg, panel], 7),
    "text-base": ensure(mix(text, muted, 0.35), [bg, panel], 4.5),
    "text-weak": ensure(muted, [bg, panel], 3.2),
    "text-weaker": ensure(mix(muted, bg, 0.35), [bg], 2.2),
    "border-weak-base": subtle,
    "border-base": border,
    "border-strong-base": c.borderActive ?? mix(border, text, 0.35),
  }

  return { seeds, overrides }
}

const variant = (src: Source, mode: Mode) => {
  const colors = colorsFromSource(src, mode)
  return colors && build(colors, mode)
}

const pretty = (id: string) =>
  id
    .split("-")
    .map((w) => (w === "ios" ? "iOS" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")

const seen = new Set<string>()
const written: string[] = []
const skipped: string[] = []

for (const dir of sources) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const id = file.replace(/\.json$/, "")
    if (seen.has(id)) continue
    seen.add(id)
    if (protectedIds.has(id) || id === "nikcli") continue

    const src = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Source
    const dark = variant(src, "dark")
    const light = variant(src, "light")
    if (!dark || !light) {
      skipped.push(id)
      continue
    }

    const theme = {
      $schema: "https://nikcli-ai.dev/desktop-theme.json",
      name: pretty(id),
      id,
      light,
      dark,
    }
    writeFileSync(path.join(out, `${id}.json`), JSON.stringify(theme, null, 2) + "\n")
    written.push(id)
  }
}

for (const extra of EXTRA_THEMES) {
  if (protectedIds.has(extra.id)) continue
  const dark = colorsFromPalette(extra.dark)
  const light = extra.light ? colorsFromPalette(extra.light) : deriveLight(dark)
  const theme = {
    $schema: "https://nikcli-ai.dev/desktop-theme.json",
    name: extra.name,
    id: extra.id,
    light: build(light, "light"),
    dark: build(dark, "dark"),
  }
  writeFileSync(path.join(out, `${extra.id}.json`), JSON.stringify(theme, null, 2) + "\n")
  if (!written.includes(extra.id)) written.push(extra.id)
}

written.sort()
const ident = (id: string) => "t_" + id.replace(/[^a-z0-9]/gi, "_")
const lines = [
  "// Generated by script/generate-themes.ts — do not edit.",
  'import type { DesktopTheme } from "./types"',
  ...written.map((id) => `import ${ident(id)} from "./themes/${id}.json"`),
  "",
  "export const GENERATED_THEMES: Record<string, DesktopTheme> = {",
  ...written.map((id) => `  ${JSON.stringify(id)}: ${ident(id)} as DesktopTheme,`),
  "}",
  "",
]
writeFileSync(manifest, lines.join("\n"))

console.log(
  `generated ${written.length} themes, skipped ${skipped.length}${skipped.length ? `: ${skipped.join(", ")}` : ""}`,
)

// Keep generated files identical to what the repo formatter would produce.
const formatted = Bun.spawnSync(
  ["bunx", "prettier", "--write", manifest, ...written.map((id) => path.join(out, `${id}.json`))],
  { cwd: root, stdout: "ignore", stderr: "inherit" },
)
if (formatted.exitCode !== 0) process.exit(formatted.exitCode)
