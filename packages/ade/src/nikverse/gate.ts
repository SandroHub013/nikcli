/**
 * The ceilings NikVerse's live gate (`scripts/nikverse-gate.ts`) holds the city to, and the verdict on a
 * set of measurements. Pure, so the ceilings are tested; the script does the measuring.
 */

export const GATE_LIMITS = {
  /**
   * The private memory of the frame (`nikverse.localhost` renderer), in MB: the highest of the cycles. The working set counts shared pages too
   * (WebView2's DLLs, memory shared with the GPU process) that are not the world's and that the system loads and drops from one cycle to the
   * next (133-143 MB on the same build), so it is reported and not judged. 115 and not 130, so the budget is not widened by the change of measure.
   */
  frameMb: 115,
  /** How much the private frame may grow from the third cycle to the fifth, in MB: a leak shows, the warming of the first cycles does not count. */
  frameGrowthAfterWarmupMb: 3,
  /** How much ADE's own renderer may grow after the world has been opened and closed, in MB. */
  adeGrowthMb: 5,
  /** CPU, in percent of one core, that the world adds when it draws nothing: its frame, plus what its GPU work adds to the GPU process. */
  stillCpuPercent: 1,
  /** Frames a second while the character walks; a display faster than this must not make the city run faster. */
  movingFps: 60,
  /** The GPU time of a frame at its 95th percentile, in ms, of the WORST of the eight shots, with no cap and no display in the way (`src/nikverse/city/bench.ts`). */
  gpuFrameP95Ms: 15,
  /** The GPU process with the world closed may not use more than this: above it ADE was busy and the measure is not valid. */
  baselineMaxPercent: 5,
  /** Frames of animation the page asks the browser for, a second, while it draws nothing: a loop of its own that never sleeps wakes the frame and the compositor at every vsync. */
  idleAnimationFramesPerSecond: 2,
  /**
   * The GPU process's own memory while the world is open at Media, in MB: the highest of the cycles, not a difference. ADE's GPU base
   * (its window alone) varied 168-260 MB between runs, so a growth over one base moved the verdict by 40 MB with the world unchanged; the
   * world's peak is steady to about 25 MB.
   */
  gpuPeakMb: 460,
} as const

/** What the script measured. Every number is in MB, milliseconds, percent of a core or frames a second. */
export interface GateMeasures {
  /** Highest private memory of the frame over the open/close cycles (the working set is information). */
  frameMb: number
  /** Private memory of the frame at the fifth cycle minus the third; NaN with fewer than five cycles. */
  frameGrowthAfterWarmupMb: number
  /** ADE renderer growth (larger of private and working set, and JS heap after a GC) 5 s after the last close. */
  adeGrowthAfter5sMb: number
  /** The same, after the wait for the process to settle. */
  adeGrowthAtRestMb: number
  adeHeapGrowthMb: number
  /** The world's frame renderer, mean over the repetitions, in the "immobile" draw mode. */
  immobileFrameCpuPercent: number
  /** The GPU process in the same time, mean over the repetitions. It is shared with ADE's own window. */
  immobileGpuCpuPercent: number
  /** The GPU process with the world closed, before it was ever opened for the measure: what ADE alone costs it. */
  baselineGpuCpuPercent: number
  /** Mean frames a second while walking. */
  movingFps: number
  /** The GPU time of a frame at the 95th percentile of the worst of the eight shots (`worstShot`): not the view a player starts in. */
  gpuFrameP95Ms: number
  /** Animation frames a second the page requested in the "immobile" mode (counted in a browser trace). */
  idleAnimationFramesPerSecond: number
  /** The highest GPU-process memory over the open/close cycles (absolute, MB). */
  gpuPeakMb: number
}

export interface GateCheck {
  name: string
  value: number
  limit: number
  ok: boolean
}

const under = (name: string, value: number, limit: number): GateCheck => ({
  name,
  value: Number(value.toFixed(2)),
  limit,
  ok: Number.isFinite(value) && value <= limit,
})

/**
 * What the world costs when it draws nothing: the CPU of its frame, plus what the GPU process uses beyond what it uses
 * for ADE alone. The GPU process is one for the whole window, so its whole use would blame the world for ADE's own
 * work (terminals, the cursor, the panels). Below the baseline counts as nothing, never as a credit.
 */
export const immobileCost = (frameCpu: number, gpuCpu: number, baselineGpuCpu: number) =>
  frameCpu + Math.max(0, gpuCpu - baselineGpuCpu)

export function gateChecks(measures: GateMeasures, limits = GATE_LIMITS): GateCheck[] {
  return [
    under("frame MB", measures.frameMb, limits.frameMb),
    under("frame growth from cycle 3 to 5, MB", measures.frameGrowthAfterWarmupMb, limits.frameGrowthAfterWarmupMb),
    under("ADE growth after 5 s, MB", measures.adeGrowthAfter5sMb, limits.adeGrowthMb),
    under("ADE growth at rest, MB", measures.adeGrowthAtRestMb, limits.adeGrowthMb),
    under("ADE heap growth, MB", measures.adeHeapGrowthMb, limits.adeGrowthMb),
    under(
      "immobile CPU (frame + GPU over baseline), %",
      immobileCost(measures.immobileFrameCpuPercent, measures.immobileGpuCpuPercent, measures.baselineGpuCpuPercent),
      limits.stillCpuPercent,
    ),
    under(
      "GPU baseline with the world closed (valid up to 5), %",
      measures.baselineGpuCpuPercent,
      limits.baselineMaxPercent,
    ),
    under(
      "animation frames a second while immobile",
      measures.idleAnimationFramesPerSecond,
      limits.idleAnimationFramesPerSecond,
    ),
    under("fps while moving", measures.movingFps, limits.movingFps + 1),
    under("GPU frame time p95, worst of the 8 shots, ms", measures.gpuFrameP95Ms, limits.gpuFrameP95Ms),
    under("GPU memory peak, MB", measures.gpuPeakMb, limits.gpuPeakMb),
  ]
}

export const gatePasses = (checks: readonly GateCheck[]) => checks.every((check) => check.ok)

export const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Number.NaN
}
export const mean = (values: readonly number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN

/** The frame's private memory, by cycle, as the gate judges it: the highest, and the growth once the first cycles have warmed it. */
export function framePrivate(cycles: readonly number[]): { peakMb: number; growthAfterWarmupMb: number } {
  const ok = cycles.length > 0 && cycles.every(Number.isFinite)
  return {
    peakMb: ok ? Math.max(...cycles) : Number.NaN,
    // The third and fifth cycle (indexes 2 and 4): fewer than five cycles cannot tell a leak from a warm-up, and is not a pass.
    growthAfterWarmupMb: ok && cycles.length >= 5 ? cycles[4] - cycles[2] : Number.NaN,
  }
}

/** GPU bases taken with the world closed needed for a growth to mean anything: one sample is ADE's mood of the moment. */
export const GPU_BASE_MIN_SAMPLES = 3

export interface GpuMemory {
  /** The highest memory of the cycles: what the gate holds to a ceiling. */
  peakMb: number
  /** The base: the median of the samples taken with the world closed; NaN with fewer than `GPU_BASE_MIN_SAMPLES`. */
  baseMb: number
  /** Peak minus base, for information only (never a check): NaN when the base is not trustworthy. */
  growthMb: number
}

/** The GPU process's memory, from the cycles (world open) and the samples taken before, between and after with the world closed. */
export function gpuMemory(cycles: readonly number[], baseSamples: readonly number[]): GpuMemory {
  const peakMb = cycles.length && cycles.every(Number.isFinite) ? Math.max(...cycles) : Number.NaN
  const samples = baseSamples.filter(Number.isFinite)
  const baseMb = samples.length >= GPU_BASE_MIN_SAMPLES ? median(samples) : Number.NaN
  return { peakMb, baseMb, growthMb: peakMb - baseMb }
}

/** What `nikverse-shots.ts` writes for each shot, as far as the gate reads it. */
export interface BenchRow {
  level: string
  n: number
  name?: string
  gpu?: { p95: number; scale?: number; sync?: string }
}

export interface WorstShot {
  /** The p95 of the worst shot, in ms; NaN when the bench is not the whole one. */
  p95: number
  n: number
  name?: string
  /** The resolution scale that shot settled at (1 where the level does not move it). */
  scale: number
  shots: number
}

/**
 * The worst of the eight shots of a level, from the bench's rows. A bench with fewer than eight shots measured, or a shot without
 * a time, is NaN: a gate must not go green on the shots that could be taken.
 */
export function worstShot(rows: readonly BenchRow[], level: string, expected = 8): WorstShot {
  const mine = rows.filter((r) => r.level === level)
  const times = mine.map((r) => r.gpu?.p95 ?? Number.NaN)
  const complete = mine.length === expected && times.every(Number.isFinite)
  let worst = mine[0]
  for (const r of mine)
    if ((r.gpu?.p95 ?? Number.NEGATIVE_INFINITY) > (worst?.gpu?.p95 ?? Number.NEGATIVE_INFINITY)) worst = r
  return {
    p95: complete ? Math.max(...times) : Number.NaN,
    n: worst?.n ?? 0,
    name: worst?.name,
    scale: worst?.gpu?.scale ?? 1,
    shots: mine.length,
  }
}
