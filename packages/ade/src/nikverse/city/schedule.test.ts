import { describe, expect, test } from "bun:test"
import { IMPOSTOR_BEYOND, SLOW_BEYOND, SLOW_POSE_MS, detailAt, poseDue, shopInRange } from "./lod"
import { IMMOBILE_AFTER_MS, POSITION_EVERY_MS, STILL_INTERVAL_MS, drawMode, shouldSavePosition } from "./schedule"

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
