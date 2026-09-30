import { describe, expect, test } from "bun:test"
import {
  GATE_LIMITS,
  gateChecks,
  gatePasses,
  immobileCost,
  mean,
  worstShot,
  type BenchRow,
  type GateMeasures,
} from "./gate"

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

  test("the frame is held to its private bytes, 115 MB; its working set is information and turns nothing red", () => {
    expect(GATE_LIMITS.frameMb).toBe(115)
    // The island's run of 2026-09-30: private 93-103, working set 133-143 (shared pages, WebView2 and the GPU's).
    expect(red({ frameMb: 103, frameWorkingSetMb: 143.5 })).toEqual([])
    expect(red({ frameMb: 116, frameWorkingSetMb: 120 })).toEqual(["frame private MB"])
  })

  test("each ceiling turns the gate red on its own, by name", () => {
    expect(red({ frameMb: GATE_LIMITS.frameMb + 1 })).toEqual(["frame private MB"])
    expect(red({ adeGrowthAfter5sMb: 5.2 })).toEqual(["ADE growth after 5 s, MB"])
    expect(red({ adeGrowthAtRestMb: 5.2 })).toEqual(["ADE growth at rest, MB"])
    expect(red({ adeHeapGrowthMb: 6 })).toEqual(["ADE heap growth, MB"])
    expect(red({ immobileFrameCpuPercent: 3 })).toEqual(["immobile CPU (frame + GPU over baseline), %"])
    expect(red({ movingFps: 90 })).toEqual(["fps while moving"])
    expect(red({ idleAnimationFramesPerSecond: 60 })).toEqual(["animation frames a second while immobile"])
    expect(red({ baselineGpuCpuPercent: 5.5 })).toEqual(["GPU baseline with the world closed (valid up to 5), %"])
    expect(red({ gpuFrameP95Ms: GATE_LIMITS.gpuFrameP95Ms + 0.5 })).toEqual([
      "GPU frame time p95, worst of the 8 shots, ms",
    ])
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
    expect(red({ gpuFrameP95Ms: Number.NaN })).toEqual(["GPU frame time p95, worst of the 8 shots, ms"])
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

describe("the worst of the eight shots", () => {
  const row = (n: number, p95: number | undefined, scale?: number): BenchRow => ({
    level: "media",
    n,
    name: `shot${n}`,
    gpu: p95 === undefined ? undefined : { p95, scale },
  })
  const eight = (p95s: number[], scales: number[] = []) => p95s.map((p, i) => row(i + 1, p, scales[i]))

  test("it is the largest p95, with the shot it belongs to and the scale that shot settled at", () => {
    const worst = worstShot(eight([4, 5, 6, 13.4, 5, 8, 9, 3], [1, 1, 1, 0.9, 1, 1, 1, 1]), "media")
    expect([worst.p95, worst.n, worst.name, worst.scale, worst.shots]).toEqual([13.4, 4, "shot4", 0.9, 8])
  })

  test("the view a player starts in (3 ms) does not decide: the desk does", () => {
    // The gate used to read `__nikverseBench` on the default view and passed on 3 ms while a shot took 16.
    const worst = worstShot(eight([3, 3, 3, 16.4, 3, 3, 3, 3]), "media")
    expect(worst.p95).toBe(16.4)
    expect(red({ gpuFrameP95Ms: worst.p95 })).toEqual(["GPU frame time p95, worst of the 8 shots, ms"])
  })

  test("a bench with fewer than eight shots, or a shot with no time, is not a pass", () => {
    expect(worstShot(eight([3, 3, 3]), "media").p95).toBeNaN()
    expect(worstShot([...eight([3, 3, 3, 3, 3, 3, 3]), row(8, undefined)], "media").p95).toBeNaN()
    expect(worstShot(eight([3, 3, 3, 3, 3, 3, 3, Number.NaN]), "media").p95).toBeNaN()
    expect(worstShot([], "media").p95).toBeNaN()
    expect(red({ gpuFrameP95Ms: worstShot([], "media").p95 })).toEqual(["GPU frame time p95, worst of the 8 shots, ms"])
  })

  test("only the rows of the level asked for count", () => {
    const rows = [...eight([3, 3, 3, 3, 3, 3, 3, 3]), { level: "bassa", n: 1, gpu: { p95: 40 } }]
    expect(worstShot(rows, "media").p95).toBe(3)
  })
})
