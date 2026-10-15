import { RGBA } from "@opentui/core"

/**
 * WCAG 2.x contrast, and the smallest change of lightness that reaches a given ratio.
 *
 * The theme engine uses it for the colours it derives (`foreground.subtle`, the badge, the diff's line numbers and
 * signs), and `script/fix-themes.ts` for the colours the theme documents declare. Lightness is moved in OKLCH, with
 * the hue kept and the chroma lowered only as far as sRGB needs: the colour stays the theme's colour, a little lighter
 * or darker.
 */

const channel = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

/** WCAG relative luminance of the colour's RGB, alpha ignored. */
export function relativeLuminance(c: RGBA): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
}

/** `fg` laid over an opaque `bg`, the way the renderer blends a colour with alpha. */
export function over(fg: RGBA, bg: RGBA): RGBA {
  if (fg.a >= 1) return fg
  const mix = (f: number, b: number) => f * fg.a + b * (1 - fg.a)
  return RGBA.fromValues(mix(fg.r, bg.r), mix(fg.g, bg.g), mix(fg.b, bg.b), 1)
}

/** WCAG contrast ratio, 1 to 21. A translucent `fg` is measured as it lands on `bg`. */
export function contrastRatio(fg: RGBA, bg: RGBA): number {
  const a = relativeLuminance(over(fg, bg))
  const b = relativeLuminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const BLACK = RGBA.fromInts(0, 0, 0)
const WHITE = RGBA.fromInts(255, 255, 255)

/** Black or white, whichever reads better on `bg` by the WCAG ratio. */
export function blackOrWhite(bg: RGBA): RGBA {
  return contrastRatio(BLACK, bg) >= contrastRatio(WHITE, bg) ? BLACK : WHITE
}

/** Whether `bg` is a dark background: white text reads better on it than black. */
export function isDarkBackground(bg: RGBA): boolean {
  return blackOrWhite(bg) === WHITE
}

type Oklch = { l: number; c: number; h: number }

export function toOklch(color: RGBA): Oklch {
  const r = channel(color.r)
  const g = channel(color.g)
  const b = channel(color.b)
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) }
}

function linearFromOklch(l: number, c: number, h: number): [number, number, number] {
  const A = c * Math.cos(h)
  const B = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}

const inGamut = (rgb: [number, number, number]) => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6)

/** The colour at OKLCH lightness `l` with the hue of `from`, its chroma lowered only as far as sRGB needs. */
export function withLightness(from: RGBA, l: number): RGBA {
  const { c, h } = toOklch(from)
  const lightness = Math.min(1, Math.max(0, l))
  let chroma = c
  if (!inGamut(linearFromOklch(lightness, chroma, h))) {
    let lo = 0
    let hi = c
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(linearFromOklch(lightness, mid, h))) lo = mid
      else hi = mid
    }
    chroma = lo
  }
  const [r, g, b] = linearFromOklch(lightness, chroma, h)
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, encode(Math.min(1, Math.max(0, v))))) * 255)
  return RGBA.fromInts(byte(r), byte(g), byte(b), Math.round(from.a * 255))
}

/** The lowest ratio of `fg` against any of `backgrounds`. */
export function worstRatio(fg: RGBA, backgrounds: readonly RGBA[]): number {
  return Math.min(...backgrounds.map((bg) => contrastRatio(fg, bg)))
}

/**
 * `fg` with the smallest change of OKLCH lightness that reaches `min` against every one of `backgrounds`; `fg`
 * itself when it already does.
 *
 * It tries lighter and darker and keeps the closer of the two that work. When neither works, the backgrounds sit on
 * both sides of every lightness that could pass, and it returns the lightness with the best worst ratio: the caller
 * can tell from `worstRatio` that `min` was out of reach. A translucent `fg` that fails is first laid on the first
 * background and comes back opaque: an alpha caps the contrast whatever its lightness.
 */
export function ensureContrast(color: RGBA, backgrounds: readonly RGBA[], min: number): RGBA {
  if (backgrounds.length === 0 || worstRatio(color, backgrounds) >= min) return color
  const fg = over(color, backgrounds[0]!)
  if (worstRatio(fg, backgrounds) >= min) return fg
  const start = toOklch(fg).l
  const passes = (c: RGBA) => worstRatio(c, backgrounds) >= min

  const toward = (end: 0 | 1): { color: RGBA; distance: number } | undefined => {
    if (!passes(withLightness(fg, end))) return undefined
    let failing = start
    let passing: number = end
    for (let i = 0; i < 30; i++) {
      const mid = (failing + passing) / 2
      if (passes(withLightness(fg, mid))) passing = mid
      else failing = mid
    }
    // Rounding to whole bytes can land a hair under the floor: step on until the colour itself passes.
    const step = end === 1 ? 0.001 : -0.001
    let l = passing
    while (!passes(withLightness(fg, l)) && l >= 0 && l <= 1) l += step
    return { color: withLightness(fg, l), distance: Math.abs(l - start) }
  }

  const options = [toward(1), toward(0)].filter((o) => o !== undefined)
  if (options.length > 0) return options.sort((a, b) => a.distance - b.distance)[0]!.color

  let lo = 0
  let hi = 1
  for (let i = 0; i < 40; i++) {
    const a = lo + (hi - lo) / 3
    const b = hi - (hi - lo) / 3
    if (worstRatio(withLightness(fg, a), backgrounds) < worstRatio(withLightness(fg, b), backgrounds)) lo = a
    else hi = b
  }
  return withLightness(fg, (lo + hi) / 2)
}
