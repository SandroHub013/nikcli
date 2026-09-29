import { describe, expect, test } from "bun:test"
import { GATE_LIMITS, gateChecks, gatePasses, immobileCost, mean, type GateMeasures } from "./gate"

const good: GateMeasures = {
  frameMb: 96,
  adeGrowthAfter5sMb: 4.7,
  adeGrowthAtRestMb: 0.5,
  adeHeapGrowthMb: 0.1,
  immobileFrameCpuPercent: 0.1,
  immobileGpuCpuPercent: 0.6,
  baselineGpuCpuPercent: 0.4,
  movingFps: 60,
  idleAnimationFramesPerSecond: 0,
  gpuFrameP95Ms: 9,
  gpuMemoryGrowthMb: 160,
}

const red = (change: Partial<GateMeasures>) =>
  gateChecks({ ...good, ...change })
    .filter((check) => !check.ok)
    .map((check) => check.name)

describe("the NikVerse gate", () => {
  test("numbers under every ceiling pass", () => {
    expect(gatePasses(gateChecks(good))).toBe(true)
  })

  test("each ceiling turns the gate red on its own, by name", () => {
    expect(red({ frameMb: GATE_LIMITS.frameMb + 1 })).toEqual(["frame MB"])
    expect(red({ adeGrowthAfter5sMb: 5.2 })).toEqual(["ADE growth after 5 s, MB"])
    expect(red({ adeGrowthAtRestMb: 5.2 })).toEqual(["ADE growth at rest, MB"])
    expect(red({ adeHeapGrowthMb: 6 })).toEqual(["ADE heap growth, MB"])
    expect(red({ immobileFrameCpuPercent: 3 })).toEqual(["immobile CPU (frame + GPU over baseline), %"])
    expect(red({ movingFps: 90 })).toEqual(["fps while moving"])
    expect(red({ idleAnimationFramesPerSecond: 60 })).toEqual(["animation frames a second while immobile"])
    expect(red({ baselineGpuCpuPercent: 5.5 })).toEqual(["GPU baseline with the world closed (valid up to 5), %"])
    expect(red({ gpuFrameP95Ms: GATE_LIMITS.gpuFrameP95Ms + 0.5 })).toEqual(["GPU frame time p95, ms"])
    expect(red({ gpuMemoryGrowthMb: GATE_LIMITS.gpuMemoryGrowthMb + 1 })).toEqual(["GPU memory growth, MB"])
  })

  test("the ceilings themselves are the plan's: GPU memory 250 MB, a frame in 15 ms at the 95th percentile", () => {
    expect(GATE_LIMITS.gpuMemoryGrowthMb).toBe(250)
    expect(GATE_LIMITS.gpuFrameP95Ms).toBe(15)
    expect(red({ gpuMemoryGrowthMb: 250 })).toEqual([])
    expect(red({ gpuFrameP95Ms: 15 })).toEqual([])
  })

  test("a measurement that could not be taken is red, not a pass", () => {
    expect(gatePasses(gateChecks({ ...good, frameMb: Number.NaN }))).toBe(false)
    expect(gatePasses(gateChecks({ ...good, immobileFrameCpuPercent: mean([]) }))).toBe(false)
    expect(red({ gpuFrameP95Ms: Number.NaN })).toEqual(["GPU frame time p95, ms"])
    expect(red({ idleAnimationFramesPerSecond: Number.NaN })).toEqual(["animation frames a second while immobile"])
    expect(red({ gpuMemoryGrowthMb: Number.NaN })).toEqual(["GPU memory growth, MB"])
    // Without a baseline the GPU's share cannot be told from ADE's: not a pass either.
    expect(red({ baselineGpuCpuPercent: Number.NaN }).sort()).toEqual([
      "GPU baseline with the world closed (valid up to 5), %",
      "immobile CPU (frame + GPU over baseline), %",
    ])
  })

  test("N2 as measured on the first live run is red on exactly the two things Dev is to fix, when the GPU baseline is taken as nothing", () => {
    const n2: GateMeasures = {
      ...good,
      frameMb: 95.8,
      adeGrowthAfter5sMb: 4.7,
      immobileFrameCpuPercent: 0.5,
      immobileGpuCpuPercent: 4,
      baselineGpuCpuPercent: 0,
      movingFps: 82,
    }
    expect(
      gateChecks(n2)
        .filter((check) => !check.ok)
        .map((check) => check.name),
    ).toEqual(["immobile CPU (frame + GPU over baseline), %", "fps while moving"])
  })
})

describe("what the world costs when it draws nothing", () => {
  test("its frame, plus the GPU process beyond what ADE alone makes it use", () => {
    expect(immobileCost(0.2, 3.1, 2.6)).toBeCloseTo(0.7, 9)
  })

  test("a GPU process below its baseline is no credit: the cost is the frame's", () => {
    expect(immobileCost(0.2, 1.0, 2.6)).toBe(0.2)
  })

  test("2.5 to 3.4 % over a GPU that ADE alone keeps at 2.5 % is under the 1 % line; over a quiet one it is not", () => {
    expect(immobileCost(0.1, 3.4, 2.5) <= GATE_LIMITS.stillCpuPercent).toBe(true)
    expect(immobileCost(0.1, 3.4, 0.1) <= GATE_LIMITS.stillCpuPercent).toBe(false)
  })

  test("no baseline is NaN, and NaN is never under a line", () => {
    expect(Number.isNaN(immobileCost(0.1, 1, Number.NaN))).toBe(true)
  })
})
