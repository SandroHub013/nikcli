import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

/*
 * ADE wears the whole ragù palette (brand choice 3, «tutta ragù»): ink and
 * crema for the grounds, pomodoro for the accent, basil for what succeeded,
 * pasta for what warns. The palette is in `ade-team/design/ragu-code/logo-data.json`.
 *
 * Every pair a token is drawn in is measured here, one by one, in both schemes:
 * text at 4.5:1 at least, interface components (accent, status marks, the focus
 * ring, a filled button against its ground) at 3:1. Where a palette colour does
 * not reach the line as text, the token holds a variant and the test says which.
 */

const css = readFileSync(join(import.meta.dir, "index.css"), "utf-8")

type Rgb = [number, number, number]
type Scheme = "light" | "dark"

const INK = "#120d0b"
const CREMA = "#f4e7cd"
const POMODORO = "#df4a2b"
const RED = "#a3271b"
const BASIL = "#7fb850"
const BASIL_DARK = "#24501a"
const PASTA = "#f1c14f"

function hex(value: string): Rgb {
  const h = value.replace("#", "")
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
}

const channel = (c: number) => {
  const x = c / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** The two values of a `light-dark(#…, #…)` token in the shared block. */
function token(name: string): Record<Scheme, Rgb> {
  const match = new RegExp(`${name}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`).exec(css)
  if (!match) throw new Error(`${name} not found as light-dark(#…, #…) in index.css`)
  return { light: hex(match[1]!), dark: hex(match[2]!) }
}

const sameColour = (a: Rgb, b: Rgb) => a.every((v, i) => v === b[i])

/*
 * OKLab distance, for «distinguishable»: about 0.02 is the smallest step an eye
 * sees. The colour-vision simulation is Machado et al. 2009 at full severity,
 * applied in linear RGB.
 */
const CVD = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const

function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(Math.max(0, 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b))
  const m = Math.cbrt(Math.max(0, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b))
  const s = Math.cbrt(Math.max(0, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b))
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function distance(a: Rgb, b: Rgb, vision?: keyof typeof CVD): number {
  const seen = (rgb: Rgb) => {
    const v = rgb.map(channel) as [number, number, number]
    if (!vision) return oklab(v)
    const m = CVD[vision]
    return oklab(m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]) as [number, number, number])
  }
  const [x, y] = [seen(a), seen(b)]
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

const TEXT = 4.5
const COMPONENT = 3
const SCHEMES: Scheme[] = ["light", "dark"]
/** Every ground text and marks are drawn on; sunken is the transcript's well. */
const GROUNDS = ["--ade-sunken", "--ade-bg", "--ade-surface", "--ade-raised", "--ade-overlay"] as const

function pair(fg: string, bg: string, scheme: Scheme, floor: number) {
  const ratio = contrast(token(fg)[scheme], token(bg)[scheme])
  return { pair: `${scheme} ${fg} on ${bg}`, ok: ratio >= floor, ratio: Number(ratio.toFixed(2)) }
}

function expectAll(rows: ReturnType<typeof pair>[]) {
  expect(rows.filter((row) => !row.ok)).toEqual([])
}

describe("the grounds are the palette's", () => {
  test("dark is ink, light is crema", () => {
    const bg = token("--ade-bg")
    expect(sameColour(bg.dark, hex(INK))).toBe(true)
    expect(sameColour(bg.light, hex(CREMA))).toBe(true)
  })

  test("the surfaces step away from the ground in the same direction, one stop at a time", () => {
    // Dark: each level lifts toward crema. Light: panels lift toward panna, wells sink toward ink.
    const order = ["--ade-sunken", "--ade-bg", "--ade-surface", "--ade-raised", "--ade-overlay"]
    const dark = order.map((name) => luminance(token(name).dark))
    expect(dark).toEqual([...dark].sort((a, b) => a - b))
    const light = order.slice(0, 4).map((name) => luminance(token(name).light))
    expect(light).toEqual([...light].sort((a, b) => a - b))
  })

  test("glass reads on ink too", () => {
    expect(/--ade-glass-ground:\s*#120d0b;/.test(css)).toBe(true)
    expect(/--ade-glass-veil:\s*rgba\(18, 13, 11,/.test(css)).toBe(true)
  })
})

describe("text, 4.5:1 on every ground", () => {
  for (const scheme of SCHEMES) {
    test(`${scheme}: the three text steps`, () => {
      expectAll(
        ["--ade-text", "--ade-text-soft", "--ade-text-weak"].flatMap((fg) =>
          GROUNDS.map((bg) => pair(fg, bg, scheme, TEXT)),
        ),
      )
    })

    test(`${scheme}: accent and the status colours as text`, () => {
      expectAll(
        ["--ade-accent", "--ade-done", "--ade-error", "--ade-warning", "--ade-working", "--ade-waiting"].flatMap(
          (fg) => GROUNDS.map((bg) => pair(fg, bg, scheme, TEXT)),
        ),
      )
    })

    test(`${scheme}: the words on a solid fill`, () => {
      expectAll([
        pair("--ade-accent-fg", "--ade-accent", scheme, TEXT),
        pair("--ade-accent-fg", "--ade-accent-strong", scheme, TEXT),
        // The bar's queue pill: the family's colour as the ground, accent-fg as the count.
        pair("--ade-accent-fg", "--ade-working", scheme, TEXT),
        ...["--ade-done", "--ade-error", "--ade-warning", "--ade-working", "--ade-waiting"].map((bg) =>
          pair("--ade-on-status", bg, scheme, TEXT),
        ),
      ])
    })
  }
})

describe("interface components, 3:1 on every ground", () => {
  for (const scheme of SCHEMES) {
    test(`${scheme}: accent, its hover fill, the status marks and the focus ring`, () => {
      expectAll(
        [
          "--ade-accent",
          "--ade-accent-strong",
          "--ade-done",
          "--ade-error",
          "--ade-warning",
          "--ade-working",
          "--ade-waiting",
          // The focus ring is drawn in text-weak (index.css, ── focus ──).
          "--ade-text-weak",
        ].flatMap((fg) => GROUNDS.map((bg) => pair(fg, bg, scheme, COMPONENT))),
      )
    })
  }
})

describe("pomodoro, basil and pasta, and the variants where they fall short", () => {
  test("dark: the accent's hover fill is pomodoro itself, ink on it", () => {
    expect(sameColour(token("--ade-accent-strong").dark, hex(POMODORO))).toBe(true)
    expect(sameColour(token("--ade-accent-fg").dark, hex(INK))).toBe(true)
  })

  test("dark: pomodoro is under 4.5:1 as text on the upper grounds, so the accent is a lighter one", () => {
    expect(contrast(hex(POMODORO), token("--ade-overlay").dark)).toBeLessThan(TEXT)
    expect(sameColour(token("--ade-accent").dark, hex(POMODORO))).toBe(false)
  })

  test("light: pomodoro is 3.3:1 on crema, so the accent darkens toward red and the hover is red", () => {
    expect(contrast(hex(POMODORO), hex(CREMA))).toBeLessThan(TEXT)
    expect(sameColour(token("--ade-accent-strong").light, hex(RED))).toBe(true)
  })

  test("success is basil in dark and basil-dark in light", () => {
    const done = token("--ade-done")
    expect(sameColour(done.dark, hex(BASIL))).toBe(true)
    expect(sameColour(done.light, hex(BASIL_DARK))).toBe(true)
  })

  test("warning is pasta in dark; pasta is 1.4:1 on crema, so light takes an ochre", () => {
    const warning = token("--ade-warning")
    expect(sameColour(warning.dark, hex(PASTA))).toBe(true)
    expect(contrast(hex(PASTA), hex(CREMA))).toBeLessThan(COMPONENT)
    expect(sameColour(warning.light, hex(PASTA))).toBe(false)
  })
})

describe("an error does not look like a pomodoro button", () => {
  for (const scheme of SCHEMES) {
    test(`${scheme}: error and accent are apart, also for protan and deutan vision`, () => {
      const accent = token("--ade-accent")[scheme]
      const error = token("--ade-error")[scheme]
      expect(distance(accent, error)).toBeGreaterThan(0.08)
      expect(distance(accent, error, "protan")).toBeGreaterThan(0.06)
      expect(distance(accent, error, "deutan")).toBeGreaterThan(0.06)
    })
  }

  test("the palette's own red would not do: it sits next to the light accent", () => {
    expect(distance(token("--ade-accent").light, hex(RED))).toBeLessThan(0.08)
  })
})

describe("lint: no teal and no old grey left in ADE's sources", () => {
  const OLD = [
    /#1a9e87/i,
    /#7fd6c4/i,
    /#148272/i,
    /#5ec4ae/i,
    /#0a1613/i,
    /rgba\(26, ?158, ?135/,
    /rgba\(127, ?214, ?196/,
    /rgba\(10, ?124, ?107/,
    /rgba\(122, ?215, ?195/,
    /#131111/i,
    /#1a1818/i,
    /#211e1e/i,
    /#2a2626/i,
    /#f4f2f0/i,
    /#faf9f8/i,
    /#eae7e4/i,
    /rgba\(19, ?17, ?17/,
  ]
  // Left out on purpose: the splash (another choice of the user), the RaguVerse
  // scene, and the terminal's sixteen ANSI colours (cyan is an ANSI colour, not the accent).
  const SKIP = ["splash", "raguverse"]

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return SKIP.includes(entry.name) || entry.name === "node_modules" ? [] : sources(path)
      if (/\.test\.tsx?$/.test(entry.name)) return []
      return /\.(css|ts|tsx)$/.test(entry.name) ? [path] : []
    })
  }

  test("lint: every stylesheet and module", () => {
    const offenders = sources(import.meta.dir).flatMap((path) =>
      readFileSync(path, "utf-8")
        .split("\n")
        .map((line, i) => ({ line, at: `${relative(import.meta.dir, path).split(sep).join("/")}:${i + 1}` }))
        .filter(({ line }) => !/--ade-ansi-/.test(line))
        // Prose that names the old colour to explain the change is not a colour.
        .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .filter(({ line }) => OLD.some((re) => re.test(line)))
        .map(({ at, line }) => `${at} ${line.trim()}`),
    )
    expect(offenders).toEqual([])
  })
})
