/**
 * The ceilings NikVerse's live gate (`scripts/nikverse-gate.ts`) holds the city to, and the verdict on a
 * set of measurements. Pure, so the ceilings are tested; the script does the measuring.
 */

export const GATE_LIMITS = {
  /** The private frame (`nikverse.localhost` renderer), in MB: the larger of private bytes and working set. */
  frameMb: 130,
  /** How much ADE's own renderer may grow after the world has been opened and closed, in MB. */
  adeGrowthMb: 5,
  /** CPU, in percent of one core, of the frame and the GPU together when the city draws nothing. */
  stillCpuPercent: 1,
  /** Frames a second while the character walks; a display faster than this must not make the city run faster. */
  movingFps: 60,
} as const

/** What the script measured. Every number is in MB, percent of a core or frames a second. */
export interface GateMeasures {
  /** Worst frame size over the open/close cycles. */
  frameMb: number
  /** ADE renderer growth (larger of private and working set, and JS heap) 5 s after the last close. */
  adeGrowthAfter5sMb: number
  /** The same, after the wait for the process to settle. */
  adeGrowthAtRestMb: number
  adeHeapGrowthMb: number
  /** Frame renderer + GPU process, mean over the repetitions, in the "immobile" draw mode. */
  immobileCpuPercent: number
  /** Mean frames a second while walking. */
  movingFps: number
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

export function gateChecks(measures: GateMeasures, limits = GATE_LIMITS): GateCheck[] {
  return [
    under("frame MB", measures.frameMb, limits.frameMb),
    under("ADE growth after 5 s, MB", measures.adeGrowthAfter5sMb, limits.adeGrowthMb),
    under("ADE growth at rest, MB", measures.adeGrowthAtRestMb, limits.adeGrowthMb),
    under("ADE heap growth, MB", measures.adeHeapGrowthMb, limits.adeGrowthMb),
    under("immobile CPU (frame + GPU), %", measures.immobileCpuPercent, limits.stillCpuPercent),
    under("fps while moving", measures.movingFps, limits.movingFps + 1),
  ]
}

export const gatePasses = (checks: readonly GateCheck[]) => checks.every((check) => check.ok)

export const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Number.NaN
}
export const mean = (values: readonly number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN
