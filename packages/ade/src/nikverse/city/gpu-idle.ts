/**
 * How to wait for the GPU to finish what a frame submitted, on either renderer, and whether its adapter has the
 * GPU's own clock. The touching of three's internals is here, in one place, with fakes in the tests.
 */

import { summarizeTiming, timeFrames, type GpuTiming } from "./bench"
import type { Backend } from "./renderers"

interface Queue {
  onSubmittedWorkDone(): Promise<void>
}

interface WebGpuInternals {
  backend?: { device?: { queue?: Queue }; adapter?: { features?: { has(name: string): boolean } } }
}

interface WebGlInternals {
  getContext?(): { finish(): void } | null
}

export function gpuIdleOf(
  renderer: unknown,
  backend: Backend,
): { idle: () => Promise<void> | void; sync: GpuTiming["sync"] } {
  if (backend === "webgpu") {
    const queue = (renderer as WebGpuInternals).backend?.device?.queue
    if (queue) return { idle: () => queue.onSubmittedWorkDone(), sync: "queue" }
  } else {
    const gl = (renderer as WebGlInternals).getContext?.()
    if (gl) return { idle: () => gl.finish(), sync: "finish" }
  }
  return { idle: () => {}, sync: "none" }
}

/** Whether the device has `timestamp-query`: the GPU's own clock (see `bench.ts`). */
export const hasTimestampQuery = (renderer: unknown): boolean => {
  const backend = (renderer as WebGpuInternals & Timestamps).backend
  return (
    backend?.hasFeature?.("timestamp-query") === true || backend?.adapter?.features?.has("timestamp-query") === true
  )
}

interface Timestamps {
  backend?: { trackTimestamp?: boolean; hasFeature?(name: string): boolean }
  resolveTimestampsAsync?(type?: string): Promise<number | undefined>
}

/**
 * The GPU's own time for each frame, in ms: the backend is set to track timestamps for the length of the timing, each
 * frame is drawn and its passes' time read. `undefined` when the device has no `timestamp-query`. A frame whose time
 * came back as nothing is NaN, so that a summary of it cannot pass a gate.
 */
export async function timestampFrames(
  renderer: unknown,
  draw: () => void,
  frames: number,
  warmup = 30,
): Promise<number[] | undefined> {
  const r = renderer as Timestamps
  const backend = r.backend
  if (!backend || !r.resolveTimestampsAsync || backend.hasFeature?.("timestamp-query") !== true) return undefined
  const before = backend.trackTimestamp
  backend.trackTimestamp = true
  try {
    const times: number[] = []
    for (let i = 0; i < warmup + frames; i++) {
      draw()
      // The passes of the frame, and the compute passes too when the frame has them (`resolve` answers nothing for a kind it never saw).
      const render = await r.resolveTimestampsAsync("render")
      const compute = await r.resolveTimestampsAsync("compute")
      if (i >= warmup)
        times.push(
          typeof render === "number" && Number.isFinite(render)
            ? render + (typeof compute === "number" && Number.isFinite(compute) ? compute : 0)
            : Number.NaN,
        )
    }
    return times
  } finally {
    backend.trackTimestamp = before ?? false
  }
}

/** Draws the view `frames` times back to back and says how long the GPU took for each. */
export async function measureGpu(
  renderer: unknown,
  backend: Backend,
  draw: () => void,
  frames = 240,
  now?: () => number,
): Promise<GpuTiming> {
  const timestampQuery = hasTimestampQuery(renderer)
  if (backend === "webgpu") {
    const stamped = await timestampFrames(renderer, draw, frames)
    if (stamped) return { ...summarizeTiming(stamped), sync: "timestamp", timestampQuery }
  }
  const { idle, sync } = gpuIdleOf(renderer, backend)
  const times = await timeFrames(frames, draw, idle, now)
  return { ...summarizeTiming(times), sync, timestampQuery }
}

interface Target {
  dispose(): void
}

/**
 * How to draw the view for timing. WebGPU presents through a swap chain that holds each frame until the display takes it,
 * so a tight loop on the canvas measures the refresh rate (every frame 16.7 ms, whatever the scene): the view is drawn
 * into a target of the same size and samples instead, which is the scene's own cost and nothing waits on a display.
 * WebGL's `finish()` is not held by the display and draws to the canvas as it is.
 */
export function benchDraw(
  renderer: { render(scene: unknown, camera: unknown): void },
  backend: Backend,
  scene: unknown,
  camera: unknown,
  makeTarget: () => Target,
): { draw: () => void; dispose: () => void } {
  if (backend !== "webgpu") return { draw: () => renderer.render(scene, camera), dispose() {} }
  const target = makeTarget()
  const to = renderer as unknown as { setRenderTarget(target: unknown): void }
  return {
    draw: () => {
      to.setRenderTarget(target)
      try {
        renderer.render(scene, camera)
      } finally {
        to.setRenderTarget(null)
      }
    },
    dispose: () => target.dispose(),
  }
}
