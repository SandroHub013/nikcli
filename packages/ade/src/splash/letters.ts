/**
 * The letters R, A, G, Ù of the splash as strokes in scene units: pure geometry, so a test can hold it without WebGL.
 *
 * Four letters take the width three took (NiK): each is 1.7 wide, 0.6 apart, so the whole word spans about ±4.3 and the
 * letters keep the height they had. The word is centred on its own bounds (the accent of the Ù included).
 */

export type Point = readonly [x: number, y: number]
export interface Segment {
  from: Point
  to: Point
}

const HALF = 0.85
const SPACING = 2.3
const TOP = 3.5
const BOTTOM = -3.5
const CORNER = 0.4

/** A polyline as the segments between its points. */
function polyline(points: Point[]): Segment[] {
  const out: Segment[] = []
  for (let i = 1; i < points.length; i++) out.push({ from: points[i - 1]!, to: points[i]! })
  return out
}

function letterR(cx: number): Segment[] {
  const l = cx - HALF
  const r = cx + HALF
  return [
    ...polyline([
      [l, BOTTOM],
      [l, TOP],
      [r - 0.3, TOP],
      [r, TOP - 0.4],
      [r, 0.9],
      [r - 0.3, 0.5],
      [l, 0.5],
    ]),
    ...polyline([
      [cx - 0.1, 0.5],
      [r, BOTTOM],
    ]),
  ]
}

function letterA(cx: number): Segment[] {
  const l = cx - HALF
  const r = cx + HALF
  return [
    ...polyline([
      [l, BOTTOM],
      [cx, TOP],
      [r, BOTTOM],
    ]),
    ...polyline([
      [l + 0.4, -1.0],
      [r - 0.4, -1.0],
    ]),
  ]
}

function letterG(cx: number): Segment[] {
  const l = cx - HALF
  const r = cx + HALF
  return polyline([
    [r, 2.9],
    [r - CORNER, TOP],
    [l + CORNER, TOP],
    [l, TOP - CORNER],
    [l, BOTTOM + CORNER],
    [l + CORNER, BOTTOM],
    [r - CORNER, BOTTOM],
    [r, BOTTOM + CORNER],
    [r, -0.2],
    [cx, -0.2],
  ])
}

function letterU(cx: number): Segment[] {
  const l = cx - HALF
  const r = cx + HALF
  return [
    ...polyline([
      [l, TOP],
      [l, BOTTOM + CORNER],
      [l + CORNER, BOTTOM],
      [r - CORNER, BOTTOM],
      [r, BOTTOM + CORNER],
      [r, TOP],
    ]),
    // The grave accent: from the upper left to the lower right, above the letter.
    ...polyline([
      [cx - 0.3, 4.8],
      [cx + 0.3, 4.1],
    ]),
  ]
}

/** The strokes of «RAGÙ», centred on the origin. */
export function raguStrokes(): Segment[] {
  const segments = [-1.5, -0.5, 0.5, 1.5].flatMap((slot, i) => {
    const cx = slot * SPACING
    return [letterR, letterA, letterG, letterU][i]!(cx)
  })
  let min = Infinity
  let max = -Infinity
  for (const s of segments) for (const p of [s.from, s.to]) ((min = Math.min(min, p[1])), (max = Math.max(max, p[1])))
  const shift = -(min + max) / 2
  return segments.map((s) => ({ from: [s.from[0], s.from[1] + shift], to: [s.to[0], s.to[1] + shift] }))
}

function length(s: Segment): number {
  return Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1])
}

/**
 * How many of `total` particles go to each stroke, by its length, so a long diagonal is as dense as a short bar.
 * The counts add up to exactly `total`: the remainder goes to the longest strokes first.
 */
export function allocate(segments: Segment[], total: number): number[] {
  const sum = segments.reduce((a, s) => a + length(s), 0)
  const counts = segments.map((s) => Math.floor((length(s) / sum) * total))
  let left = total - counts.reduce((a, c) => a + c, 0)
  const order = segments.map((_, i) => i).sort((a, b) => length(segments[b]!) - length(segments[a]!))
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) counts[order[i]!]!++
  return counts
}
