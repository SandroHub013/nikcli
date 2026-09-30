/**
 * Dynamic resolution: the share of its pixel ratio a level draws at, from 0.75 to 1, moved by the GPU's own frame time.
 *
 * The pixel ratio is a ceiling, not a promise (`min(devicePixelRatio, level.pixelRatio)`), and on the integrated GPUs Media is
 * for, a close-up interior is limited by pixels: at half the size it takes a third of the time. So the frame is kept inside its
 * budget by drawing fewer pixels for a moment, not by dropping the samples that keep the edges clean. It goes down a step when
 * the frame's 95th percentile is above 14 ms and up a step when it is below 11: between the two it stays, and a step down
 * cannot bring the number under the line for going up (the cost falls with the square of the scale), so it does not oscillate.
 * The gate reads the same rule from the bench: the scale a shot settles at is recorded, and one that cannot fit at 0.75 is red.
 */

import { percentile, type GpuTiming } from "./bench"

export const SCALE_MIN = 0.75
export const SCALE_MAX = 1
export const SCALE_STEP = 0.05
/** Above this p95 (ms) the scale goes down a step. */
export const SCALE_DOWN_ABOVE_MS = 14
/** Below this p95 (ms) it goes up a step. */
export const SCALE_UP_BELOW_MS = 11
/** GPU frame times looked at for each decision: about a second of frames at one in three. */
export const SAMPLE_WINDOW = 20

const round = (scale: number) => Math.round(scale * 100) / 100

/** The scale after looking at a p95: a step down, a step up, or the same. A p95 that is not a number changes nothing. */
export function nextScale(scale: number, p95: number, max = SCALE_MAX): number {
  if (!Number.isFinite(p95)) return scale
  if (p95 > SCALE_DOWN_ABOVE_MS) return Math.max(SCALE_MIN, round(scale - SCALE_STEP))
  if (p95 < SCALE_UP_BELOW_MS) return Math.min(max, round(scale + SCALE_STEP))
  return scale
}

export interface Governor {
  scale(): number
  /** Takes one GPU frame time (ms); answers the new scale when this one completed a window and it changed. */
  push(ms: number): number | undefined
}

/** `max` is the ceiling of the scale (the measuring door's, `?maxscale=`); a level's own is 1. */
export function createGovernor(start = SCALE_MAX, window = SAMPLE_WINDOW, max = SCALE_MAX): Governor {
  let scale = start
  let times: number[] = []
  return {
    scale: () => scale,
    push(ms) {
      // A frame that could not be timed is not a fast one: it is left out.
      if (!Number.isFinite(ms)) return undefined
      times.push(ms)
      if (times.length < window) return undefined
      const p95 = percentile(
        [...times].sort((a, b) => a - b),
        0.95,
      )
      times = []
      const next = nextScale(scale, p95, max)
      if (next === scale) return undefined
      scale = next
      return next
    },
  }
}

export interface Settled extends GpuTiming {
  /** The scale the shot settled at. */
  scale: number
  /** Each scale tried and its p95, in order. */
  steps: Array<{ scale: number; p95: number }>
}

/**
 * What the governor would settle at for a fixed view: measure at full scale, and while the p95 is over the line and there is
 * room, take a step down and measure again. `measure` draws the view at that scale and times it.
 */
export async function settle(measure: (scale: number) => Promise<GpuTiming>, max = SCALE_MAX): Promise<Settled> {
  const steps: Settled["steps"] = []
  let scale = max
  for (;;) {
    const timing = await measure(scale)
    steps.push({ scale, p95: timing.p95 })
    const next = timing.p95 > SCALE_DOWN_ABOVE_MS ? nextScale(scale, timing.p95) : scale
    if (next === scale) return { ...timing, scale, steps }
    scale = next
  }
}
