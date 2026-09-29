import { describe, expect, test } from "bun:test"
import {
  benchDraw,
  benchScaled,
  gpuIdleOf,
  hasTimestampQuery,
  liveGpuTimer,
  measureGpu,
  timestampFrames,
} from "./gpu-idle"
import type { Settled } from "./resolution"

describe("waiting for the GPU", () => {
  test("WebGPU waits for the queue to drain", async () => {
    let waited = 0
    const renderer = { backend: { device: { queue: { onSubmittedWorkDone: async () => void waited++ } } } }
    const { idle, sync } = gpuIdleOf(renderer, "webgpu")
    expect(sync).toBe("queue")
    await idle()
    expect(waited).toBe(1)
  })

  test("WebGL calls finish() on its context", () => {
    let finished = 0
    const { idle, sync } = gpuIdleOf({ getContext: () => ({ finish: () => void finished++ }) }, "webgl2")
    expect(sync).toBe("finish")
    idle()
    expect(finished).toBe(1)
  })

  test("a renderer that shows neither says «none», so that the number is known not to be a GPU time", () => {
    expect(gpuIdleOf({}, "webgpu").sync).toBe("none")
    expect(gpuIdleOf({}, "webgl2").sync).toBe("none")
    expect(gpuIdleOf({ getContext: () => null }, "webgl2").sync).toBe("none")
  })

  test("the adapter's timestamp-query is reported, and only when it says so", () => {
    const withFeature = { backend: { adapter: { features: { has: (n: string) => n === "timestamp-query" } } } }
    expect(hasTimestampQuery(withFeature)).toBe(true)
    expect(hasTimestampQuery({ backend: { adapter: { features: { has: () => false } } } })).toBe(false)
    expect(hasTimestampQuery({})).toBe(false)
    // The device's own answer counts too: three asks it, and the adapter's list is not always where it looks.
    expect(hasTimestampQuery({ backend: { hasFeature: (n: string) => n === "timestamp-query" } })).toBe(true)
  })
})

describe("measuring the GPU", () => {
  test("it draws, waits, and summarises: 240 frames of 5 ms with one slow in ten make the p95 the slow one", async () => {
    let clock = 0
    let n = 0
    const renderer = {
      backend: { device: { queue: { onSubmittedWorkDone: async () => void (clock += n % 10 === 0 ? 30 : 5) } } },
    }
    const timing = await measureGpu(
      renderer,
      "webgpu",
      () => void n++,
      240,
      () => clock,
    )
    expect(timing.frames).toBe(240)
    expect(timing.p50).toBe(5)
    expect(timing.p95).toBe(30)
    expect(timing.sync).toBe("queue")
    expect(timing.timestampQuery).toBe(false)
  })
})

describe("drawing for the timing", () => {
  const scene = {}
  const camera = {}

  test("WebGPU draws into a target and puts the canvas back, and frees the target", () => {
    const log: string[] = []
    const target = { dispose: () => void log.push("dispose") }
    const renderer = {
      setRenderTarget: (t: unknown) => void log.push(t === null ? "canvas" : "target"),
      render: () => void log.push("render"),
    }
    const { draw, dispose } = benchDraw(renderer, "webgpu", scene, camera, () => target)
    draw()
    draw()
    dispose()
    expect(log).toEqual(["target", "render", "canvas", "target", "render", "canvas", "dispose"])
  })

  test("a draw that throws still gives the canvas back", () => {
    const log: string[] = []
    const renderer = {
      setRenderTarget: (t: unknown) => void log.push(t === null ? "canvas" : "target"),
      render: () => {
        throw new Error("boom")
      },
    }
    const { draw } = benchDraw(renderer, "webgpu", scene, camera, () => ({ dispose() {} }))
    expect(draw).toThrow("boom")
    expect(log.at(-1)).toBe("canvas")
  })

  test("WebGL draws to the canvas as it is, and makes no target", () => {
    let made = 0
    let rendered = 0
    const { draw, dispose } = benchDraw(
      { render: () => void rendered++ },
      "webgl2",
      scene,
      camera,
      () => (made++, { dispose() {} }),
    )
    draw()
    dispose()
    expect([made, rendered]).toEqual([0, 1])
  })

  test("the target is made once, when the timing starts, not at every frame", () => {
    let made = 0
    const renderer = { setRenderTarget() {}, render() {} }
    const { draw } = benchDraw(renderer, "webgpu", scene, camera, () => (made++, { dispose() {} }))
    for (let i = 0; i < 10; i++) draw()
    expect(made).toBe(1)
  })
})

describe("the GPU's own clock", () => {
  /** A renderer with timestamps: each frame it draws costs what `costs` says, read back by `resolveTimestampsAsync`. */
  function stamped(costs: number[], compute: Array<number | undefined> = []) {
    let frame = -1
    const seen: boolean[] = []
    const renderer = {
      backend: {
        trackTimestamp: false,
        hasFeature: (n: string) => n === "timestamp-query",
        adapter: { features: { has: () => true } },
      },
      resolveTimestampsAsync: async (type = "render") =>
        type === "render" ? costs[frame % costs.length] : compute[frame % Math.max(1, compute.length)],
    }
    const draw = () => {
      frame++
      seen.push(renderer.backend.trackTimestamp)
    }
    return { renderer, draw, seen }
  }

  test("each frame's time is read from the GPU, tracking is on only while it runs, and it is off again after", async () => {
    const { renderer, draw, seen } = stamped([4])
    const times = await timestampFrames(renderer, draw, 10)
    expect(times).toEqual(Array.from({ length: 10 }, () => 4))
    expect(seen.every(Boolean)).toBe(true)
    expect(renderer.backend.trackTimestamp).toBe(false)
  })

  test("tracking that was on stays on", async () => {
    const { renderer, draw } = stamped([4])
    renderer.backend.trackTimestamp = true
    await timestampFrames(renderer, draw, 2)
    expect(renderer.backend.trackTimestamp).toBe(true)
  })

  test("compute passes are added to the frame's time, and a frame without any adds nothing", async () => {
    const { renderer, draw } = stamped([4], [1.5, undefined])
    const times = await timestampFrames(renderer, draw, 4, 0)
    expect(times).toEqual([5.5, 4, 5.5, 4])
  })

  test("the live timer tracks one frame on request: on at begin, the time at end, off after, and a frame it could not time is NaN", async () => {
    const { renderer } = stamped([4], [1])
    const timer = liveGpuTimer(renderer)!
    expect(renderer.backend.trackTimestamp).toBe(false)
    timer.begin()
    expect(renderer.backend.trackTimestamp).toBe(true)
    expect(await timer.end()).toBe(5)
    expect(renderer.backend.trackTimestamp).toBe(false)
    const lost = stamped([Number.NaN])
    const other = liveGpuTimer(lost.renderer)!
    other.begin()
    expect(await other.end()).toBeNaN()
    expect(lost.renderer.backend.trackTimestamp).toBe(false)
  })

  test("the live timer leaves tracking on when something else had it on, and is absent without timestamp-query", async () => {
    const { renderer } = stamped([4])
    renderer.backend.trackTimestamp = true
    const timer = liveGpuTimer(renderer)!
    timer.begin()
    await timer.end()
    expect(renderer.backend.trackTimestamp).toBe(true)
    expect(
      liveGpuTimer({ backend: { hasFeature: () => false }, resolveTimestampsAsync: async () => 1 }),
    ).toBeUndefined()
    expect(liveGpuTimer({})).toBeUndefined()
  })

  test("a device with no timestamp-query answers nothing, so the caller falls back", async () => {
    const renderer = { backend: { hasFeature: () => false }, resolveTimestampsAsync: async () => 1 }
    expect(await timestampFrames(renderer, () => {}, 3)).toBeUndefined()
    expect(await timestampFrames({}, () => {}, 3)).toBeUndefined()
  })

  test("a frame whose time did not come back is NaN, and the summary is NaN with it", async () => {
    const { renderer, draw } = stamped([4, Number.NaN])
    const timing = await measureGpu(renderer, "webgpu", draw, 20)
    expect(timing.sync).toBe("timestamp")
    expect(timing.p95).toBeNaN()
  })

  test("measureGpu says «timestamp» when it used the GPU's clock, and falls back to the queue when there is none", async () => {
    const { renderer, draw } = stamped([6])
    const a = await measureGpu(renderer, "webgpu", draw, 20)
    expect([a.sync, a.p50, a.p95, a.timestampQuery]).toEqual(["timestamp", 6, 6, true])
    let clock = 0
    const plain = { backend: { device: { queue: { onSubmittedWorkDone: async () => void (clock += 7) } } } }
    const b = await measureGpu(
      plain,
      "webgpu",
      () => {},
      20,
      () => clock,
    )
    expect([b.sync, b.p50, b.timestampQuery]).toEqual(["queue", 7, false])
  })

  test("WebGL never uses timestamps, even if a renderer showed the fields", async () => {
    const { renderer, draw } = stamped([6])
    const timing = await measureGpu({ ...renderer, getContext: () => ({ finish() {} }) }, "webgl2", draw, 5)
    expect(timing.sync).toBe("finish")
  })
})

describe("timing at the scales the level would settle at", () => {
  /** A WebGPU renderer whose frames cost `cost(width)` ms of GPU, in a target of the width it was last given. */
  function scaledWorld(cost: (width: number) => number) {
    let width = 0
    const sizes: number[] = []
    const renderer = {
      backend: {
        trackTimestamp: false,
        hasFeature: (n: string) => n === "timestamp-query",
        adapter: { features: { has: () => true } },
      },
      setRenderTarget() {},
      render() {},
      resolveTimestampsAsync: async (type = "render") => (type === "render" ? cost(width) : undefined),
    }
    return {
      bench: {
        renderer,
        backend: "webgpu" as const,
        scene: {},
        camera: {},
        makeTarget: (w: number) => ((width = w), sizes.push(w), { dispose() {} }),
        width: 1600,
        height: 900,
        frames: 10,
      },
      sizes,
    }
  }

  test("a level that moves its scale is timed at full size and steps down while over the line, and says where it settled", async () => {
    // Fill-bound: 17 ms at 1600 wide, falling with the square of the width.
    const { bench, sizes } = scaledWorld((w) => 17 * (w / 1600) ** 2)
    const timing = (await benchScaled({ ...bench, dynamic: true })) as Settled
    expect(timing.scale).toBe(0.9)
    expect([...new Set(sizes)]).toEqual([1600, 1520, 1440])
    expect(timing.p95).toBeCloseTo(13.77, 1)
  })

  test("a level that does not is timed once at full size and carries no scale", async () => {
    const { bench, sizes } = scaledWorld(() => 20)
    const timing = await benchScaled({ ...bench, dynamic: false })
    expect("scale" in timing).toBe(false)
    expect([...new Set(sizes)]).toEqual([1600])
    expect(timing.p95).toBe(20)
  })
})
