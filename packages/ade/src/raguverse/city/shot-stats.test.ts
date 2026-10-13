import { describe, expect, test } from "bun:test"
import { MAX_BLACK, MAX_BURNT, analyze, problemsOf } from "./shot-stats"

const SKY = [11, 18, 38] as const

/** A picture of `w`×`h` pixels, each given by `paint(index)`. */
function picture(w: number, h: number, paint: (i: number) => [number, number, number, number?]) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const [r, g, b, a = 255] = paint(i)
    data.set([r, g, b, a], i * 4)
  }
  return data
}

describe("the numbers of a shot", () => {
  test("a picture that is all sky is all sky, and its luminance is the sky's", () => {
    const s = analyze(
      picture(10, 10, () => [11, 18, 38]),
      10,
      10,
      SKY,
    )
    expect(s.sky).toBe(1)
    expect(s.black).toBe(0)
    expect(s.burnt).toBe(0)
    expect(s.luminance).toBeCloseTo((0.2126 * 11 + 0.7152 * 18 + 0.0722 * 38) / 255, 6)
  })

  test("black counts only outside the sky, and sky within a few levels is still sky", () => {
    // 1 pure black, 1 near-black that is not sky, 1 that is 3 levels off the sky, 97 mid grey.
    const s = analyze(
      picture(10, 10, (i) => (i === 0 ? [0, 0, 0] : i === 1 ? [1, 1, 1] : i === 2 ? [14, 21, 41] : [128, 128, 128])),
      10,
      10,
      SKY,
    )
    expect(s.black).toBeCloseTo(0.02, 9)
    expect(s.sky).toBeCloseTo(0.01, 9)
  })

  test("burnt is every channel at 250 or more, not one channel", () => {
    const s = analyze(
      picture(10, 10, (i) => (i < 3 ? [255, 255, 250] : i < 8 ? [255, 255, 200] : [90, 90, 90])),
      10,
      10,
      SKY,
    )
    expect(s.burnt).toBeCloseTo(0.03, 9)
  })

  test("a pixel that is not opaque is counted", () => {
    const s = analyze(
      picture(4, 4, (i) => [100, 100, 100, i < 4 ? 0 : 255]),
      4,
      4,
      SKY,
    )
    expect(s.transparent).toBeCloseTo(0.25, 9)
  })
})

describe("what the checks refuse", () => {
  const fine = { pixels: 100, sky: 0.3, black: 0, burnt: 0.001, transparent: 0, luminance: 0.3 }

  test("a healthy picture passes", () => {
    expect(problemsOf(fine, [0.1, 0.5])).toEqual([])
  })

  test("black beyond its limit, burnt beyond its limit, and a luminance outside its band each fail on their own", () => {
    expect(problemsOf({ ...fine, black: MAX_BLACK }, [0.1, 0.5])).toEqual([])
    expect(problemsOf({ ...fine, black: MAX_BLACK * 1.01 }, [0.1, 0.5])).toHaveLength(1)
    expect(problemsOf({ ...fine, burnt: MAX_BURNT }, [0.1, 0.5])).toEqual([])
    expect(problemsOf({ ...fine, burnt: MAX_BURNT * 1.01 }, [0.1, 0.5])).toHaveLength(1)
    expect(problemsOf({ ...fine, luminance: 0.09 }, [0.1, 0.5])[0]).toContain("outside its band")
    expect(problemsOf({ ...fine, luminance: 0.51 }, [0.1, 0.5])[0]).toContain("outside its band")
    expect(problemsOf({ ...fine, luminance: 0.1 }, [0.1, 0.5])).toEqual([])
  })

  test("NaN never passes: an empty picture, a NaN luminance, a NaN share", () => {
    expect(problemsOf({ ...fine, pixels: 0 }, [0, 1]).length).toBeGreaterThan(0)
    expect(problemsOf({ ...fine, luminance: Number.NaN }, [0, 1]).length).toBeGreaterThan(0)
    // A NaN share compares false with every limit: it is named, not waved through.
    expect(problemsOf({ ...fine, black: Number.NaN }, [0, 1])).toEqual(["black is not a number"])
    expect(problemsOf({ ...fine, burnt: Number.NaN }, [0, 1])).toEqual(["burnt is not a number"])
  })

  test("a picture that is not opaque fails", () => {
    expect(problemsOf({ ...fine, transparent: 0.5 }, [0, 1])[0]).toContain("not opaque")
  })
})
