import { describe, expect, test } from "bun:test"
import { percentile, summarizeTiming, timeFrames } from "./bench"

describe("the percentile", () => {
  test("nearest rank: the 95th of 100 values is the 95th", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(values, 0.95)).toBe(95)
    expect(percentile(values, 0.5)).toBe(50)
    expect(percentile(values, 1)).toBe(100)
    expect(percentile(values, 0)).toBe(1)
  })

  test("a short list gives its ends, and an empty one is NaN, not zero", () => {
    expect(percentile([7], 0.95)).toBe(7)
    expect(percentile([1, 2], 0.95)).toBe(2)
    expect(percentile([], 0.95)).toBeNaN()
  })
})

describe("the summary", () => {
  test("mean, median, p95 and worst of an unsorted list", () => {
    const ms = [10, 2, 4, 8, 6, 12, 14, 16, 18, 20]
    const s = summarizeTiming(ms)
    expect(s).toEqual({ frames: 10, mean: 11, p50: 10, p95: 20, max: 20 })
  })

  test("one slow frame in twenty does not move the p95 past the twentieth, and two do", () => {
    const one = [...Array.from({ length: 19 }, () => 8), 90]
    expect(summarizeTiming(one).p95).toBe(8)
    const two = [...Array.from({ length: 18 }, () => 8), 90, 90]
    expect(summarizeTiming(two).p95).toBe(90)
  })

  test("one frame that could not be timed makes the whole summary NaN", () => {
    const s = summarizeTiming([5, 5, Number.NaN, 5, Number.POSITIVE_INFINITY])
    expect(s.frames).toBe(5)
    expect([s.mean, s.p50, s.p95, s.max].every(Number.isNaN)).toBe(true)
  })

  test("nothing measured is NaN all through, so that a gate cannot pass on it", () => {
    const s = summarizeTiming([])
    expect([s.mean, s.p50, s.p95, s.max].every(Number.isNaN)).toBe(true)
    expect(s.frames).toBe(0)
  })
})

describe("timing the frames", () => {
  test("it draws the warm-up and the frames, waits for the GPU after each, and keeps only the frames", async () => {
    let clock = 0
    const log: string[] = []
    const times = await timeFrames(
      5,
      () => log.push("draw"),
      () => {
        log.push("idle")
        clock += 4
      },
      () => clock,
      3,
    )
    expect(times).toEqual([4, 4, 4, 4, 4])
    expect(log).toHaveLength((3 + 5) * 2)
    // Never two draws in a row: each frame ends with the GPU idle before the next starts.
    for (let i = 0; i < log.length; i += 2) expect(log.slice(i, i + 2)).toEqual(["draw", "idle"])
  })

  test("the time of a frame is the time until the GPU is idle, an asynchronous wait included", async () => {
    let clock = 0
    const times = await timeFrames(
      2,
      () => {
        clock += 1
      },
      async () => {
        await Promise.resolve()
        clock += 9
      },
      () => clock,
      1,
    )
    expect(times).toEqual([10, 10])
  })
})
