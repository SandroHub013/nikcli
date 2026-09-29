/**
 * The ceilings NikVerse's live gate (`scripts/nikverse-gate.ts`) holds the city to, and the verdict on a
 * set of measurements. Pure, so the ceilings are tested; the script does the measuring.
 */

export const GATE_LIMITS = {
  /** The private frame (`nikverse.localhost` renderer), in MB: the larger of private bytes and working set. */
  frameMb: 130,
  /** How much ADE's own renderer may grow after the world has been opened and closed, in MB. */
  adeGrowthMb: 5,
  /** CPU, in percent of one core, that the world adds when it draws nothing: its frame, plus what its GPU work adds to the GPU process. */
  stillCpuPercent: 1,
  /** Frames a second while the character walks; a display faster than this must not make the city run faster. */
  movingFps: 60,
  /** The GPU time of a frame at its 95th percentile, in ms, with no cap and no display in the way (`src/nikverse/city/bench.ts`). */
  gpuFrameP95Ms: 15,
  /** How much the GPU process may grow while the world is open, in MB (the level's textures, geometry and targets). */
  gpuMemoryGrowthMb: 250,
} as const

/** What the script measured. Every number is in MB, milliseconds, percent of a core or frames a second. */
export interface GateMeasures {
  /** Worst frame size over the open/close cycles. */
  frameMb: number
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
  /** The GPU time of a frame at the 95th percentile, from the world's own bench. */
  gpuFrameP95Ms: number
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
    under("frame MB", measures.frameMb, limits.frameMb),
    under("ADE growth after 5 s, MB", measures.adeGrowthAfter5sMb, limits.adeGrowthMb),
    under("ADE growth at rest, MB", measures.adeGrowthAtRestMb, limits.adeGrowthMb),
    under("ADE heap growth, MB", measures.adeHeapGrowthMb, limits.adeGrowthMb),
    under(
      "immobile CPU (frame + GPU over baseline), %",
      immobileCost(measures.immobileFrameCpuPercent, measures.immobileGpuCpuPercent, measures.baselineGpuCpuPercent),
      limits.stillCpuPercent,
    ),
    under("fps while moving", measures.movingFps, limits.movingFps + 1),
    under("GPU frame time p95, ms", measures.gpuFrameP95Ms, limits.gpuFrameP95Ms),
    under("GPU memory growth, MB", measures.gpuMemoryGrowthMb, limits.gpuMemoryGrowthMb),
  ]
}

export const gatePasses = (checks: readonly GateCheck[]) => checks.every((check) => check.ok)

export const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Number.NaN
}
export const mean = (values: readonly number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN
