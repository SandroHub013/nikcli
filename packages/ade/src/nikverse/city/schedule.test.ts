import { describe, expect, test } from "bun:test"
import { IMPOSTOR_BEYOND, SLOW_BEYOND, SLOW_POSE_MS, detailAt, poseDue, shopInRange } from "./lod"
import { IMMOBILE_AFTER_MS, POSITION_EVERY_MS, STILL_INTERVAL_MS, drawMode, pace, shouldSavePosition } from "./schedule"

describe("the three ways to draw", () => {
  test("moving draws every frame; standing with the hologram turning draws 15 a second; quiet for ten seconds draws nothing", () => {
    expect(drawMode({ moving: true, sinceActivityMs: 0 })).toBe("moving")
    expect(drawMode({ moving: true, sinceActivityMs: 60_000 })).toBe("moving")
    expect(drawMode({ moving: false, sinceActivityMs: 0 })).toBe("still")
    expect(drawMode({ moving: false, sinceActivityMs: IMMOBILE_AFTER_MS - 1 })).toBe("still")
    expect(drawMode({ moving: false, sinceActivityMs: IMMOBILE_AFTER_MS })).toBe("immobile")
  })

  test("the resting rate is 15 frames a second and the quiet time is ten seconds", () => {
    expect(Math.round(1000 / STILL_INTERVAL_MS)).toBe(15)
    expect(IMMOBILE_AFTER_MS).toBe(10_000)
  })
})

describe("telling ADE where the character is", () => {
  const still = { moving: false, sentAt: 0 }
  const walking = { moving: true, sentAt: 0 }

  test("when it stops, at once", () => {
    expect(shouldSavePosition(walking, { moving: false, at: 100 })).toBe(true)
  })

  test("while it walks, every three seconds and not before", () => {
    expect(shouldSavePosition(walking, { moving: true, at: POSITION_EVERY_MS - 1 })).toBe(false)
    expect(shouldSavePosition(walking, { moving: true, at: POSITION_EVERY_MS })).toBe(true)
    expect(shouldSavePosition({ moving: true, sentAt: 10_000 }, { moving: true, at: 11_000 })).toBe(false)
  })

  test("standing still, never: nothing has changed", () => {
    expect(shouldSavePosition(still, { moving: false, at: 999_999 })).toBe(false)
  })

  test("when it starts to walk, not yet: the place it left is already kept", () => {
    expect(shouldSavePosition(still, { moving: true, at: 10 })).toBe(false)
  })
})

describe("how much of a person is drawn", () => {
  test("near the whole figure, past 15 metres a slow one, past 30 an impostor", () => {
    expect(detailAt(0)).toBe("full")
    expect(detailAt(SLOW_BEYOND)).toBe("full")
    expect(detailAt(SLOW_BEYOND + 0.01)).toBe("slow")
    expect(detailAt(IMPOSTOR_BEYOND)).toBe("slow")
    expect(detailAt(IMPOSTOR_BEYOND + 0.01)).toBe("impostor")
    expect([SLOW_BEYOND, IMPOSTOR_BEYOND]).toEqual([15, 30])
  })

  test("the pose of a near person is worked out every frame, a far one's ten times a second, an impostor's never", () => {
    expect(poseDue("full", 1, 0.999)).toBe(true)
    expect(poseDue("slow", 1, 0.9 + 1e-6)).toBe(false)
    expect(poseDue("slow", 1, 0.9 - 1e-6)).toBe(true)
    expect(poseDue("slow", 5, -1)).toBe(true)
    expect(poseDue("impostor", 100, -1)).toBe(false)
    expect(SLOW_POSE_MS).toBe(100)
  })

  test("a shop far past the range is not drawn, one near is, by its edge and not its centre", () => {
    const camera = { x: 0, z: 0 }
    expect(shopInRange(camera, { x: 30, z: 0 }, 9)).toBe(true)
    expect(shopInRange(camera, { x: 200, z: 0 }, 9)).toBe(false)
    expect(shopInRange(camera, { x: 148, z: 0 }, 9)).toBe(true)
    expect(shopInRange(camera, { x: 150, z: 0 }, 9)).toBe(false)
  })
})

describe("pacing the draws to the level's frame rate", () => {
  /** The draws in `seconds` of a display at `hz`, with the timestamps a little uneven, as a display's are. */
  const drawsOn = (hz: number, interval: number, seconds = 10) => {
    let next = 0
    let draws = 0
    const frame = 1000 / hz
    for (let i = 1; i * frame <= seconds * 1000; i++) {
      const ts = i * frame + (i % 3) * 0.3 - 0.3
      const step = pace(ts, next, interval)
      next = step.next
      if (step.draw) draws++
    }
    return draws / seconds
  }

  test("never above 60 a second, whatever the display: 60, 75, 120, 144, 165 and 240 Hz", () => {
    // (60.1 is the first frame of the ten seconds, which draws at once.)
    for (const hz of [60, 75, 120, 144, 165, 240]) expect([hz, drawsOn(hz, 1000 / 60) <= 60.15]).toEqual([hz, true])
  })

  test("and as near to 60 as the display allows: not the 48 a plain minimum gap gives on 144 Hz, nor half on 60 Hz", () => {
    for (const hz of [60, 75, 120, 144, 240]) expect([hz, drawsOn(hz, 1000 / 60) >= 59.5]).toEqual([hz, true])
  })

  test("Bassa's 30 a second is kept on a 60, 120 or 144 Hz display", () => {
    for (const hz of [60, 120, 144]) {
      const rate = drawsOn(hz, 1000 / 30)
      expect([hz, rate <= 30.15 && rate >= 29.5]).toEqual([hz, true])
    }
  })

  test("a frame long after its due time starts the grid again instead of drawing in a burst to catch up", () => {
    const late = pace(1000, 100, 16.67)
    expect(late.draw).toBe(true)
    expect(late.next).toBeCloseTo(1016.67, 2)
    expect(pace(1001, late.next, 16.67).draw).toBe(false)
  })

  test("a shorter interval does not wait out the longer one: standing at 66 ms, then walking at 16.7", () => {
    // Drawn at t = 0 with the still interval: the next is due at 66. The character starts to walk at t = 5.
    const step = pace(0, 0, 66)
    expect(step.next).toBeCloseTo(66, 6)
    expect(pace(17, step.next, 16.67).draw).toBe(true)
  })
})
