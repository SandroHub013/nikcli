import { describe, expect, test } from "bun:test"
import {
  GATE_LIMITS,
  GPU_BASE_MIN_SAMPLES,
  gateChecks,
  gatePasses,
  framePrivate,
  gpuMemory,
  immobileCost,
  mean,
  worstShot,
  type BenchRow,
  type GateMeasures,
} from "./gate"

const good: GateMeasures = {
  frameMb: 96,
  frameGrowthAfterWarmupMb: 1,
  adeGrowthAfter5sMb: 4.7,
  adeGrowthAtRestMb: 0.5,
  adeHeapGrowthMb: 0.1,
  immobileFrameCpuPercent: 0.1,
  immobileGpuCpuPercent: 0.6,
  baselineGpuCpuPercent: 0.4,
  movingFps: 60,
  idleAnimationFramesPerSecond: 0,
  gpuFrameP95Ms: 9,
  gpuPeakMb: 430,
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
    expect(red({ frameGrowthAfterWarmupMb: GATE_LIMITS.frameGrowthAfterWarmupMb + 0.5 })).toEqual(["frame growth over cycle 3, MB"])
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
    expect(red({ gpuPeakMb: GATE_LIMITS.gpuPeakMb + 1 })).toEqual(["GPU memory peak, MB"])
  })

  test("the ceilings themselves are the plan's: GPU memory peak 460 MB at Media, a frame in 15 ms at the 95th percentile", () => {
    expect(GATE_LIMITS.gpuPeakMb).toBe(460)
    expect(GATE_LIMITS.gpuFrameP95Ms).toBe(15)
    expect(GATE_LIMITS.frameMb).toBe(115)
    expect(GATE_LIMITS.frameGrowthAfterWarmupMb).toBe(3)
    expect(red({ frameMb: 115, frameGrowthAfterWarmupMb: 3 })).toEqual([])
    expect(red({ gpuPeakMb: 460 })).toEqual([])
    expect(red({ gpuFrameP95Ms: 15 })).toEqual([])
  })

  test("a measurement that could not be taken is red, not a pass", () => {
    expect(gatePasses(gateChecks({ ...good, frameMb: Number.NaN }))).toBe(false)
    expect(gatePasses(gateChecks({ ...good, immobileFrameCpuPercent: mean([]) }))).toBe(false)
    expect(red({ gpuFrameP95Ms: Number.NaN })).toEqual(["GPU frame time p95, worst of the 8 shots, ms"])
    expect(red({ idleAnimationFramesPerSecond: Number.NaN })).toEqual(["animation frames a second while immobile"])
    expect(red({ gpuPeakMb: Number.NaN })).toEqual(["GPU memory peak, MB"])
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

describe("the GPU memory the gate reads", () => {
  // The five cycles measured at Media with the scale ceiling at 0.9 (gpu-opzioni, c) and the three bases that run took.
  const cycles = [438, 423, 424, 448, 428]

  test("the verdict is the highest of the cycles, whatever the base was", () => {
    expect(gpuMemory(cycles, [168, 233, 260]).peakMb).toBe(448)
    expect(gpuMemory(cycles, [400, 401, 402]).peakMb).toBe(448)
    expect(red({ gpuPeakMb: gpuMemory(cycles, [168]).peakMb })).toEqual([])
    expect(red({ gpuPeakMb: gpuMemory([...cycles, 481], []).peakMb })).toEqual(["GPU memory peak, MB"])
  })

  test("the growth is information only, over the median of at least three bases", () => {
    const m = gpuMemory(cycles, [168, 233, 260])
    expect(m.baseMb).toBe(233)
    expect(m.growthMb).toBe(448 - 233)
    expect(GPU_BASE_MIN_SAMPLES).toBe(3)
    // One outlier does not move the base the way a single sample would.
    expect(gpuMemory(cycles, [200, 205, 500]).baseMb).toBe(205)
  })

  test("fewer than three bases give no growth (NaN), and the peak still stands; a NaN cycle is no peak", () => {
    const two = gpuMemory(cycles, [168, 233])
    expect(Number.isNaN(two.baseMb)).toBe(true)
    expect(Number.isNaN(two.growthMb)).toBe(true)
    expect(two.peakMb).toBe(448)
    expect(Number.isNaN(gpuMemory([], [1, 2, 3]).peakMb)).toBe(true)
    expect(Number.isNaN(gpuMemory([430, Number.NaN], [1, 2, 3]).peakMb)).toBe(true)
    expect(gpuMemory(cycles, [168, Number.NaN, 233, 260]).baseMb).toBe(233)
  })
})

describe("the frame's private memory the gate reads", () => {
  // Private memory of the frame by cycle in Dario's tappa 4 (93-103 MB); the working set of the same runs was 141-143.5.
  const priv = [93, 98, 101, 103, 102]

  test("the verdict is the highest private memory of the cycles", () => {
    expect(framePrivate(priv).peakMb).toBe(103)
    expect(red({ frameMb: framePrivate(priv).peakMb })).toEqual([])
    expect(red({ frameMb: framePrivate([...priv, 118]).peakMb })).toEqual(["frame MB"])
  })

  test("the growth is the highest cycle from the third on over the third: warming up is not a leak, a rise is, even one that falls back", () => {
    expect(framePrivate(priv).growthAfterWarmupMb).toBe(2)
    expect(framePrivate([80, 95, 96, 96, 96]).growthAfterWarmupMb).toBe(0)
    // A peak at the fourth cycle that the fifth has given back still counts; and with more than five cycles every one from the third does.
    expect(framePrivate([90, 92, 94, 99, 95]).growthAfterWarmupMb).toBe(5)
    // Master's example: 106 at the fourth cycle over the third's 102 is 4 MB, red, though the fifth (103) is only 1 over.
    expect(framePrivate([100, 101, 102, 106, 103]).growthAfterWarmupMb).toBe(4)
    expect(red({ frameGrowthAfterWarmupMb: framePrivate([100, 101, 102, 106, 103]).growthAfterWarmupMb })).toEqual(["frame growth over cycle 3, MB"])
    expect(framePrivate([90, 92, 94, 95, 96, 96, 101]).growthAfterWarmupMb).toBe(7)
    expect(red({ frameGrowthAfterWarmupMb: framePrivate([90, 92, 94, 97, 99]).growthAfterWarmupMb })).toEqual(["frame growth over cycle 3, MB"])
  })

  test("fewer than five cycles, or a cycle without a number, give no growth (red) rather than a pass", () => {
    expect(Number.isNaN(framePrivate([90, 92, 94]).growthAfterWarmupMb)).toBe(true)
    expect(framePrivate([90, 92, 94]).peakMb).toBe(94)
    expect(red({ frameGrowthAfterWarmupMb: framePrivate([90, 92, 94]).growthAfterWarmupMb })).toEqual(["frame growth over cycle 3, MB"])
    expect(Number.isNaN(framePrivate([90, Number.NaN, 94, 95, 96]).peakMb)).toBe(true)
    expect(Number.isNaN(framePrivate([]).peakMb)).toBe(true)
  })
})
