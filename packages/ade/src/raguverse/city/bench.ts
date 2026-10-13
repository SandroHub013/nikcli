/**
 * The GPU time of a frame, for the gate and the bench: the city draws the same view again and again, with no cap and no
 * display in the way, waiting after each frame for the GPU to be idle, and the time each took is kept. What comes out is
 * the frame time a GPU-bound city would run at, in milliseconds, and its 95th percentile.
 *
 * Where the adapter has `timestamp-query` the time is the GPU's own clock, read through three's timestamp pools (the
 * backend is switched to tracking only while the timing runs: the real loop pays nothing). Where it has not, the wait
 * for the queue to drain (WebGPU) or `finish()` (WebGL) stands in, and the result says so in `sync`.
 */

export interface GpuTiming {
  /** Frames measured (the warm-up is not counted). */
  frames: number
  mean: number
  p50: number
  p95: number
  max: number
  /**
   * Where the time comes from: the GPU's own clock (`timestamp`), the wait for the queue of WebGPU to drain (`queue`),
   * `finish()` of WebGL, or nothing (`none`: the number is not a GPU time).
   */
  sync: "timestamp" | "queue" | "finish" | "none"
  timestampQuery: boolean
  /** The share of the level's pixel ratio the view settled at (`resolution.ts`); absent where the level does not move it. */
  scale?: number
  /** Each scale tried and its p95, in order. */
  steps?: Array<{ scale: number; p95: number }>
}

/** The value at quantile `q` (0..1) of a sorted list, nearest rank. */
export function percentile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return Number.NaN
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

export function summarizeTiming(ms: readonly number[]): Pick<GpuTiming, "frames" | "mean" | "p50" | "p95" | "max"> {
  // One frame that could not be timed spoils the whole measurement: a gate must not pass on the frames that could.
  if (ms.some((v) => !Number.isFinite(v)))
    return { frames: ms.length, mean: Number.NaN, p50: Number.NaN, p95: Number.NaN, max: Number.NaN }
  const sorted = [...ms].sort((a, b) => a - b)
  return {
    frames: ms.length,
    mean: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : Number.NaN,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : Number.NaN,
  }
}

/** Draws `warmup + frames` times, waiting after each for the GPU, and returns the time of the last `frames`. */
export async function timeFrames(
  frames: number,
  draw: () => void,
  idle: () => Promise<void> | void,
  now: () => number = () => performance.now(),
  warmup = 30,
): Promise<number[]> {
  const times: number[] = []
  for (let i = 0; i < warmup + frames; i++) {
    const t0 = now()
    draw()
    await idle()
    if (i >= warmup) times.push(now() - t0)
  }
  return times
}
