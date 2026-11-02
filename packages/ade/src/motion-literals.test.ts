import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "bun"

/*
 * DS-28 and DS-23 (2026-11-02 audit).
 *
 * DS-28: `0.12s` ×8, `120ms ease` ×3 and a handful of `scale(0.88)` and
 * `scale(0.97)` were typed where `--ade-dur-fast` and `--ade-press` exist. The
 * chrome under 24px does not scale at all (the comment at `--ade-press` says
 * so), so the two 18-20px buttons that scaled to 0.88 now press by background.
 *
 * DS-23: in dark, on a raised surface (#241e1b, where most lines live),
 * `--ade-border-subtle` was 1.03:1 and `--ade-border` 1.15:1, both invisible,
 * and the «three-step ramp» was one step.
 */
const dir = import.meta.dir
const sheets = [...new Glob("**/*.css").scanSync(dir)].map((file) => ({
  file: file.replaceAll("\\", "/"),
  text: readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
}))
const index = sheets.find((sheet) => sheet.file === "index.css")!.text

/** `text` with every `var(…)` taken out, innermost first, so a fallback inside one is not a literal of the declaration. */
function withoutVars(text: string): string {
  let out = text
  for (let before = ""; before !== out; ) {
    before = out
    out = out.replace(/var\([^()]*\)/g, "")
  }
  return out
}

describe("durations come from the tokens (DS-28)", () => {
  test("no transition writes a duration in ms or s", () => {
    const literal = sheets.flatMap(({ file, text }) =>
      [...text.matchAll(/(?:^|[;{\s])transition(?:-duration)?\s*:\s*([^;}]*)/g)]
        .map((match) => match[1]!.trim().replace(/\s+/g, " "))
        .filter((value) => /(?:^|[\s,])\d*\.?\d+m?s\b/.test(withoutVars(value)))
        .map((value) => `${file}: ${value}`),
    )
    // The reduced-motion reset is the one place a literal belongs: it is a floor, not a rhythm.
    expect(literal.filter((line) => !line.startsWith("index.css: 0.01ms"))).toEqual([])
  })
})

describe("presses come from the token (DS-28)", () => {
  test("no :active rule scales by a number", () => {
    const literal = sheets.flatMap(({ file, text }) =>
      [...text.matchAll(/([^{}]*:active[^{}]*)\{([^}]*)\}/g)]
        .filter((match) => /transform\s*:\s*[^;]*scale\(\s*[\d.]+\s*\)/.test(match[2]!))
        .map((match) => `${file}: ${match[1]!.trim().replace(/\s+/g, " ")}`),
    )
    // A list row's press (nik's 0.99) is a different feel from a button's, and press.test.ts keeps it apart.
    expect(literal.filter((line) => !line.startsWith('command/palette.css: [data-component="palette"] [data-slot="option"]'))).toEqual([])
  })

  test("the small chrome (the 18 and 20px buttons) does not scale at all", () => {
    for (const [file, selector] of [
      ["grid/pane.css", '[data-slot="pane-action"]:active'],
      ["shots/tray.css", '[data-slot="shot-dismiss"]:active'],
    ] as const) {
      const text = sheets.find((sheet) => sheet.file === file)!.text
      const rule = new RegExp(`${selector.replace(/[[\]"=]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(text)?.[1] ?? ""
      expect(`${file} ${selector}: ${/transform/.test(rule)}`).toBe(`${file} ${selector}: false`)
    }
  })
})

describe("the border ramp on a raised surface, in dark (DS-23)", () => {
  type Rgb = [number, number, number]
  const hex = (value: string): Rgb => [0, 2, 4].map((i) => parseInt(value.slice(1 + i, 3 + i), 16)) as Rgb
  const channel = (c: number) => {
    const x = c / 255
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  const contrast = (a: Rgb, b: Rgb) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
    return (hi + 0.05) / (lo + 0.05)
  }
  const dark = (name: string) => {
    const match = new RegExp(`--ade-${name}:\\s*light-dark\\(#[0-9a-fA-F]{6},\\s*(#[0-9a-fA-F]{6})\\)`).exec(index)
    if (!match) throw new Error(`--ade-${name} not found`)
    return hex(match[1]!)
  }
  const raised = dark("raised")

  test("subtle is seen at 1.15:1 and the border at 1.3:1", () => {
    expect(contrast(dark("border-subtle"), raised)).toBeGreaterThanOrEqual(1.15)
    expect(contrast(dark("border"), raised)).toBeGreaterThanOrEqual(1.3)
  })

  test("the ramp is still three steps, on raised and on the ground", () => {
    for (const ground of [raised, dark("bg")]) {
      const steps = ["border-subtle", "border", "border-strong"].map((name) => contrast(dark(name), ground))
      expect(steps[0]!).toBeLessThan(steps[1]!)
      expect(steps[1]!).toBeLessThan(steps[2]!)
      // Far enough apart to be three: the strong step is at least 0.15 over the middle one.
      expect(steps[2]! - steps[1]!).toBeGreaterThanOrEqual(0.15)
    }
  })
})
