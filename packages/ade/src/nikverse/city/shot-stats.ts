/**
 * What the bench measures on each shot's pixels, and the limits the automatic checks hold it to. Pure: the page
 * hands over the RGBA bytes it read from the canvas, the script and the tests read the numbers.
 */

export interface ShotStats {
  pixels: number
  /** Pixels the same as the sky's colour (within 3 levels), as a share. */
  sky: number
  /** Pixels that are pure black (every channel ≤ 1) and are not sky: what a NaN or a missing texture draws. */
  black: number
  /** Pixels that are burnt: every channel ≥ 250. */
  burnt: number
  /** Pixels that are not opaque: the canvas of a shot has no alpha. */
  transparent: number
  /** The mean luminance of the whole picture, 0..1, in sRGB values (Rec. 709 weights). */
  luminance: number
}

export const SKY_TOLERANCE = 3
/** At most this share of a picture may be black outside the sky. */
export const MAX_BLACK = 0.001
/** At most this share of a picture may be burnt. */
export const MAX_BURNT = 0.02

export function analyze(
  data: ArrayLike<number>,
  width: number,
  height: number,
  sky: readonly [number, number, number],
): ShotStats {
  const pixels = width * height
  let skyCount = 0
  let black = 0
  let burnt = 0
  let transparent = 0
  let luma = 0
  for (let i = 0; i < pixels; i++) {
    const p = i * 4
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    if (data[p + 3] < 255) transparent++
    luma += 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (
      Math.abs(r - sky[0]) <= SKY_TOLERANCE &&
      Math.abs(g - sky[1]) <= SKY_TOLERANCE &&
      Math.abs(b - sky[2]) <= SKY_TOLERANCE
    ) {
      skyCount++
      continue
    }
    if (r <= 1 && g <= 1 && b <= 1) black++
    if (r >= 250 && g >= 250 && b >= 250) burnt++
  }
  return {
    pixels,
    sky: pixels ? skyCount / pixels : 0,
    black: pixels ? black / pixels : 0,
    burnt: pixels ? burnt / pixels : 0,
    transparent: pixels ? transparent / pixels : 0,
    luminance: pixels ? luma / pixels / 255 : 0,
  }
}

/** What is wrong with a shot's numbers, as sentences; empty when the shot passes. */
export function problemsOf(stats: ShotStats, band: readonly [number, number]): string[] {
  const found: string[] = []
  const share = (v: number) => `${(v * 100).toFixed(3)} %`
  if (!(stats.pixels > 0)) found.push("the picture has no pixels")
  for (const [name, value] of Object.entries(stats)) if (!Number.isFinite(value)) found.push(`${name} is not a number`)
  if (stats.transparent > 0) found.push(`${share(stats.transparent)} of the pixels are not opaque`)
  if (stats.black > MAX_BLACK)
    found.push(`${share(stats.black)} of the pixels are pure black outside the sky (limit ${share(MAX_BLACK)})`)
  if (stats.burnt > MAX_BURNT) found.push(`${share(stats.burnt)} of the pixels are burnt (limit ${share(MAX_BURNT)})`)
  if (stats.luminance < band[0] || stats.luminance > band[1])
    found.push(`the mean luminance ${stats.luminance.toFixed(3)} is outside its band ${band[0]}..${band[1]}`)
  return found
}
