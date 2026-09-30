import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  SPLASH_FLOOR_MS,
  SPLASH_SCENE_DEADLINE_MS,
  SPLASH_SCENE_DELAY_MS,
  sceneIsWorthBuilding,
  splashRemainingMs,
} from "./timing"

const source = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8")

describe("the startup screen's timing", () => {
  test("it stays up at most a second and a half when the start is fast", () => {
    expect(SPLASH_FLOOR_MS).toBeLessThanOrEqual(1500)
    expect(splashRemainingMs(0, 80)).toBe(SPLASH_FLOOR_MS - 80)
  })

  test("a floor and not a delay: a start that took longer than the floor waits for nothing", () => {
    expect(splashRemainingMs(0, SPLASH_FLOOR_MS)).toBe(0)
    expect(splashRemainingMs(0, SPLASH_FLOOR_MS + 4000)).toBe(0)
  })

  test("the scene starts after 300 ms, well inside the floor, so a warm start never builds it", () => {
    expect(SPLASH_SCENE_DELAY_MS).toBe(300)
    expect(SPLASH_SCENE_DELAY_MS).toBeLessThan(SPLASH_FLOOR_MS)
  })

  test("a scene that is not ready by 1.1 s is not built: it would show for a moment and leave with the splash", () => {
    expect(SPLASH_SCENE_DEADLINE_MS).toBe(1100)
    // After the delay, so it has time to arrive; before the floor, so it is still on screen for a while.
    expect(SPLASH_SCENE_DEADLINE_MS).toBeGreaterThan(SPLASH_SCENE_DELAY_MS)
    expect(SPLASH_SCENE_DEADLINE_MS).toBeLessThan(SPLASH_FLOOR_MS)
    expect(sceneIsWorthBuilding(0, SPLASH_SCENE_DELAY_MS + 50)).toBe(true)
    expect(sceneIsWorthBuilding(1000, 1000 + SPLASH_SCENE_DEADLINE_MS - 1)).toBe(true)
    expect(sceneIsWorthBuilding(1000, 1000 + SPLASH_SCENE_DEADLINE_MS)).toBe(false)
    expect(sceneIsWorthBuilding(0, 4000)).toBe(false)
  })

  test("the splash asks before building, after three.js has arrived and before anything is made from it", () => {
    const splash = source("splash/splash.tsx")
    const arrived = splash.indexOf('await import("three")')
    const asked = splash.indexOf("sceneIsWorthBuilding(appearedAt, performance.now())")
    const built = splash.indexOf("new three.Scene()")
    expect(arrived).toBeGreaterThan(-1)
    expect(asked).toBeGreaterThan(arrived)
    expect(built).toBeGreaterThan(asked)
    // The time counts from when the splash appeared, taken at mount and not when the scene starts.
    expect(splash).toMatch(/const appearedAt = performance\.now\(\)/)
  })

  test("the workbench reads the floor from here (no second number of its own) and the splash the scene delay", () => {
    const workbench = source("surface/workbench.tsx")
    expect(workbench).toContain("splashRemainingMs")
    expect(workbench).not.toMatch(/const SPLASH_FLOOR_MS\s*=/)
    const splash = source("splash/splash.tsx")
    expect(splash).toContain("SPLASH_SCENE_DELAY_MS")
    // Nothing loads three before the delay: the import lives in `startScene`, which only the timer calls.
    expect(splash).toMatch(/setTimeout\([\s\S]*startScene/)
  })
})
