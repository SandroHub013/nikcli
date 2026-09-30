/**
 * The ceilings NikVerse's live gate (`scripts/nikverse-gate.ts`) holds the city to, and the verdict on a
 * set of measurements. Pure, so the ceilings are tested; the script does the measuring.
 */

export const GATE_LIMITS = {
  /**
   * The frame (`nikverse.localhost` renderer), in MB: its private bytes, the worst of the cycles. Not its working set,
   * which counts the pages it shares (WebView2's DLLs, the memory shared with the GPU process) and moves from one run
   * to the next with no change to the world: the Architect's decision of 2026-09-30 (`nikverse-gpu-decisione.md`).
   * 115, not the old 130 on the larger of the two, so that the budget is not widened on the quiet.
   */
  frameMb: 115,
  /**
   * How much the frame's private bytes may still rise once it is warm: from the third cycle to the last, in MB. The
   * first cycles fill the process's caches and do not count; after them a rise is a leak (the Architect, 2026-09-30).
   */
  frameLateGrowthMb: 3,
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
  /** How much the GPU process may grow while the world is open, in MB (the level's textures, geometry and targets). */
  gpuMemoryGrowthMb: 250,
} as const

/** What the script measured. Every number is in MB, milliseconds, percent of a core or frames a second. */
export interface GateMeasures {
  /** Worst frame private bytes over the open/close cycles. */
  frameMb: number
  /** Worst frame working set over the cycles: in the report for information, held to no ceiling. */
  frameWorkingSetMb?: number
  /** The frame's private bytes after the third cycle over the third's (`lateGrowth`); NaN with fewer than four cycles. */
  frameLateGrowthMb: number
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
  /** The most the GPU process grew over its closed-world baseline while the world was open. */
  gpuMemoryGrowthMb: number
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
    under("frame private MB", measures.frameMb, limits.frameMb),
    under("frame private growth from cycle 3, MB", measures.frameLateGrowthMb, limits.frameLateGrowthMb),
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
    under("GPU memory growth, MB", measures.gpuMemoryGrowthMb, limits.gpuMemoryGrowthMb),
  ]
}

export const gatePasses = (checks: readonly GateCheck[]) => checks.every((check) => check.ok)

export const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Number.NaN
}
/**
 * How much a series rose once warm: the highest value after the third over the third. NaN when there is nothing after
 * the third to judge by (fewer than four cycles): the gate runs five.
 */
export function lateGrowth(values: readonly number[]): number {
  if (values.length < 4) return Number.NaN
  return Math.max(...values.slice(3)) - values[2]
}

export const mean = (values: readonly number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN

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
