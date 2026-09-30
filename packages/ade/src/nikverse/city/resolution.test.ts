import { describe, expect, test } from "bun:test"
import type { GpuTiming } from "./bench"
import {
  SAMPLE_WINDOW,
  SCALE_DOWN_ABOVE_MS,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_STEP,
  SCALE_UP_BELOW_MS,
  createGovernor,
  nextScale,
  settle,
} from "./resolution"

const timing = (p95: number): GpuTiming => ({
  frames: 1,
  mean: p95,
  p50: p95,
  p95,
  max: p95,
  sync: "timestamp",
  timestampQuery: true,
})

describe("the rule", () => {
  test("the range is 0.75 to 1, and the lines are the Architect's: down above 14 ms, up below 11", () => {
    expect([SCALE_MIN, SCALE_MAX, SCALE_STEP, SCALE_DOWN_ABOVE_MS, SCALE_UP_BELOW_MS]).toEqual([0.75, 1, 0.05, 14, 11])
  })

  test("over 14 ms a step down, under 11 a step up, between the two it stays", () => {
    expect(nextScale(1, 14.5)).toBe(0.95)
    expect(nextScale(0.95, 10.9)).toBe(1)
    for (const p95 of [11, 12.5, 14]) expect(nextScale(0.9, p95)).toBe(0.9)
  })

  test("it never leaves its range, and never lands between steps", () => {
    expect(nextScale(0.75, 30)).toBe(0.75)
    expect(nextScale(1, 2)).toBe(1)
    let scale = 1
    for (let i = 0; i < 20; i++) scale = nextScale(scale, 30)
    expect(scale).toBe(0.75)
    for (let i = 0; i < 20; i++) scale = nextScale(scale, 1)
    expect(scale).toBe(1)
    expect(nextScale(0.85, 20)).toBe(0.8)
  })

  test("a p95 that is not a number changes nothing", () => {
    expect(nextScale(0.9, Number.NaN)).toBe(0.9)
    expect(nextScale(0.9, Number.POSITIVE_INFINITY)).toBe(0.9)
  })

  test("a scene limited by pixels settles and does not oscillate: cost falls with the square of the scale", () => {
    // At full scale the frame takes `full` ms; at scale s, full * s * s. Run the rule for a while and see it stop.
    for (const full of [9, 12, 15, 17, 20, 30]) {
      let scale = 1
      const seen: number[] = []
      for (let i = 0; i < 30; i++) {
        scale = nextScale(scale, full * scale * scale)
        seen.push(scale)
      }
      expect(seen.slice(-10).every((s) => s === seen.at(-1))).toBe(true)
    }
  })
})

describe("the governor", () => {
  test("it decides once a window is full, and says so only when the scale changed", () => {
    const g = createGovernor(1, 4)
    expect([g.push(20), g.push(20), g.push(20)]).toEqual([undefined, undefined, undefined])
    expect(g.push(20)).toBe(0.95)
    expect(g.scale()).toBe(0.95)
    // A window that keeps the scale answers nothing.
    for (let i = 0; i < 3; i++) g.push(12)
    expect(g.push(12)).toBeUndefined()
    expect(g.scale()).toBe(0.95)
  })

  test("a ceiling below 1 (the measuring door's) holds: the scale never goes up past it, and starts at it", async () => {
    expect(nextScale(0.9, 8, 0.9)).toBe(0.9)
    expect(nextScale(0.85, 8, 0.9)).toBe(0.9)
    const g = createGovernor(0.9, 2, 0.9)
    expect(g.scale()).toBe(0.9)
    g.push(5)
    expect(g.push(5)).toBeUndefined()
    // The bench settles from the same ceiling: a view that fits is measured once, at it.
    const seen: number[] = []
    const settled = await settle(async (scale) => {
      seen.push(scale)
      return timing(10)
    }, 0.9)
    expect(seen).toEqual([0.9])
    expect(settled.scale).toBe(0.9)
  })

  test("it decides on the 95th percentile of the window, not on its mean or its worst", () => {
    const g = createGovernor(1, 20)
    // 18 fast frames and 2 slow: the 95th percentile of 20 is the 19th, which is slow.
    for (let i = 0; i < 18; i++) g.push(6)
    g.push(30)
    expect(g.push(30)).toBe(0.95)
    // One slow frame in 20 is not enough.
    const h = createGovernor(0.9, 20)
    for (let i = 0; i < 19; i++) h.push(12)
    expect(h.push(40)).toBeUndefined()
  })

  test("frames that could not be timed are left out of the window, not counted as fast", () => {
    const g = createGovernor(0.9, 2)
    g.push(Number.NaN)
    g.push(Number.NaN)
    expect(g.push(20)).toBeUndefined()
    expect(g.push(20)).toBe(0.85)
  })

  test("the window is a second's worth of samples", () => {
    expect(SAMPLE_WINDOW).toBe(20)
  })
})

describe("what a fixed view settles at, for the bench", () => {
  test("a view inside its budget stays at full scale, and is timed once", async () => {
    const asked: number[] = []
    const settled = await settle(async (scale) => (asked.push(scale), timing(11)))
    expect(asked).toEqual([1])
    expect(settled.scale).toBe(1)
    expect(settled.p95).toBe(11)
  })

  test("a view over the line takes steps down until it is under, and records where it stopped and what it tried", async () => {
    const settled = await settle(async (scale) => timing(17 * scale * scale))
    // 17 * 0.95^2 = 15.3, * 0.9^2 = 13.8: two steps.
    expect(settled.scale).toBe(0.9)
    expect(settled.steps.map((s) => s.scale)).toEqual([1, 0.95, 0.9])
    expect(settled.p95).toBeCloseTo(13.77, 1)
  })

  test("a view that does not fit even at 0.75 stops there, and its p95 shows it", async () => {
    const settled = await settle(async () => timing(30))
    expect(settled.scale).toBe(0.75)
    expect(settled.p95).toBe(30)
    expect(settled.steps).toHaveLength(6)
  })

  test("a measure that could not be taken ends the search, it does not loop", async () => {
    const settled = await settle(async () => timing(Number.NaN))
    expect(settled.steps).toHaveLength(1)
    expect(Number.isNaN(settled.p95)).toBe(true)
  })
})
