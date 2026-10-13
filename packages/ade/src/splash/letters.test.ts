import { describe, expect, test } from "bun:test"
import { allocate, raguStrokes } from "./letters"

describe("the splash letters (RAGÙ)", () => {
  const strokes = raguStrokes()
  const xs = strokes.flatMap((s) => [s.from[0], s.to[0]])
  const ys = strokes.flatMap((s) => [s.from[1], s.to[1]])

  test("the word is centred and about as wide as the old NiK (±4.2)", () => {
    expect(Math.min(...xs)).toBeCloseTo(-Math.max(...xs), 5)
    expect(Math.max(...xs)).toBeGreaterThan(4.1)
    expect(Math.max(...xs)).toBeLessThan(4.5)
    expect(Math.min(...ys)).toBeCloseTo(-Math.max(...ys), 5)
  })

  test("four letters, left to right, with a gap between them", () => {
    // The letters are 1.7 wide and 2.3 apart: no stroke crosses the middle of a gap.
    for (const gap of [-2.3, 0, 2.3]) {
      for (const s of strokes) {
        const lo = Math.min(s.from[0], s.to[0])
        const hi = Math.max(s.from[0], s.to[0])
        expect(lo < gap && hi > gap).toBe(false)
      }
    }
  })

  test("the Ù has an accent above the other letters", () => {
    const top = (from: number, to: number) =>
      Math.max(...strokes.filter((s) => s.from[0] > from && s.to[0] < to).flatMap((s) => [s.from[1], s.to[1]]))
    expect(top(2.3, 5)).toBeGreaterThan(top(-5, 2.3))
  })

  test("the particles add up to exactly the total and every stroke has some", () => {
    for (const total of [2000, 1999, 100]) {
      const counts = allocate(strokes, total)
      expect(counts.reduce((a, c) => a + c, 0)).toBe(total)
      if (total >= 1000) expect(counts.every((c) => c > 0)).toBe(true)
    }
  })
})
