import { beforeEach, describe, expect, test } from "bun:test"
import { createVialLoop, type LoopEnv } from "./loop"
import { shadeLiquid, vialGeometry } from "./paint"
import { animating, fill, resetVialsForTests, Surface, Vial, vialFor } from "./sim"

/* The vial of DS-S62-5 variant 1 in the Design and Decisions buttons (S62). */

/** Steps a vial `seconds` as the loop does at 240 steps a second. */
function run(vial: Vial, seconds: number) {
  const h = 1 / 240
  for (let t = 0; t < seconds; t += h) vial.step(h)
}

describe("the liquid", () => {
  test("the level says how many, up to five", () => {
    expect(fill(0)).toBe(0)
    expect(fill(1)).toBeCloseTo(0.28)
    expect(fill(3)).toBeCloseTo(0.64)
    expect(fill(5)).toBe(1)
    expect(fill(9)).toBe(1)
  })

  test("a wave does not change the volume", () => {
    const s = new Surface(20, 2.6, 7)
    s.kick(0.3, 1, 0.12)
    for (let i = 0; i < 200; i++) s.step(1 / 240)
    const mean = [...s.h].reduce((a, b) => a + b, 0) / s.M
    expect(Math.abs(mean)).toBeLessThan(1e-9)
    expect(s.energy()).toBeGreaterThan(0)
  })

  test("an arrival falls in, the count catches up when the drop lands, and the level rises to it", () => {
    const vial = new Vial("design")
    vial.setN(1)
    vial.arrive(false)
    expect(vial.N).toBe(2)
    expect(vial.shownN).toBe(1)
    expect(vial.drops).toHaveLength(1)
    run(vial, 0.6)
    expect(vial.drops).toHaveLength(0)
    expect(vial.shownN).toBe(2)
    run(vial, 3)
    expect(vial.L).toBeCloseTo(fill(2), 2)
  })

  test("an answer lowers the level and sloshes; with nothing left it settles grey and still", () => {
    const vial = new Vial("dec")
    vial.setN(1)
    vial.answer(false)
    expect(vial.N).toBe(0)
    expect(vial.gesture).toBeGreaterThan(0)
    run(vial, 6)
    vial.gesture = 0
    expect(vial.moving()).toBe(false)
    expect(vial.L).toBe(0)
    expect(vial.tone).toBe(0)
  })

  test("with reduced motion a change is a snap: no drop, no gesture", () => {
    const vial = new Vial("design")
    vial.setN(1)
    vial.arrive(true)
    expect(vial.drops).toHaveLength(0)
    expect(vial.gesture).toBe(0)
    expect(vial.L).toBeCloseTo(fill(2))
  })
})

describe("when it needs frames", () => {
  test("during a gesture and its settling only: at rest with items waiting it is a still picture", () => {
    const vial = new Vial("design")
    vial.setN(2)
    expect(animating(vial)).toBe(false)
    vial.arrive(false)
    expect(animating(vial)).toBe(true)
    run(vial, 6)
    vial.gesture = 0
    expect(animating(vial)).toBe(false)
    expect(vial.N).toBe(3)
  })

  test("resting, the surface does not move on its own", () => {
    const vial = new Vial("dec")
    vial.setN(4)
    run(vial, 5)
    expect(vial.s.energy()).toBe(0)
    expect(vial.L).toBeCloseTo(fill(4), 6)
  })
})

describe("the tubes kept per family", () => {
  beforeEach(() => resetVialsForTests())

  test("the first count is taken as it is: opening ADE with three waiting is not three arrivals", () => {
    const vial = vialFor("design", 3, false)
    expect(vial.N).toBe(3)
    expect(vial.drops).toHaveLength(0)
    expect(vial.gesture).toBe(0)
  })

  test("later changes are gestures, one per item, and the tube outlives its button", () => {
    const vial = vialFor("dec", 0, false)
    // The button is hidden at zero and drawn again for the first item: the same tube, and the drop falls.
    expect(vialFor("dec", 2, false)).toBe(vial)
    expect(vial.drops).toHaveLength(2)
    vialFor("dec", 1, false)
    expect(vial.N).toBe(1)
  })
})

/** A fake display: frames run when `advance` passes them, 60 a second. */
function fakeEnv() {
  let now = 0
  let nextId = 1
  const rafs = new Map<number, (now: number) => void>()
  const state = { still: false, frames: 0 }
  const env: LoopEnv = {
    raf: (callback) => {
      const id = nextId++
      rafs.set(id, callback)
      return id
    },
    cancelRaf: (id) => void rafs.delete(id),
    still: () => state.still,
  }
  const advance = (seconds: number) => {
    const end = now + seconds * 1000
    while (now < end - 1e-6) {
      now += 1000 / 60
      const due = [...rafs]
      rafs.clear()
      for (const [, callback] of due) {
        state.frames++
        callback(now)
      }
    }
  }
  return { env, state, advance, pending: () => rafs.size }
}

describe("the loop", () => {
  test("a gesture draws at the display's rate for a few seconds, then nothing is pending", () => {
    const { env, state, advance, pending } = fakeEnv()
    const loop = createVialLoop(env)
    const vial = new Vial("design")
    vial.setN(1)
    let paints = 0
    loop.add({ vial, paint: () => paints++ })
    vial.arrive(false)
    loop.wake()
    advance(1)
    expect(state.frames).toBeGreaterThanOrEqual(55)
    advance(5)
    expect(pending()).toBe(0)
    expect(loop.running()).toBe(false)
    // At rest, with two waiting: no frame at all.
    state.frames = 0
    paints = 0
    advance(10)
    expect(state.frames).toBe(0)
    expect(paints).toBe(0)
  })

  test("with items waiting and no change, adding the button draws one frame and stops", () => {
    const { env, state, advance, pending } = fakeEnv()
    const loop = createVialLoop(env)
    const vial = new Vial("dec")
    vial.setN(3)
    let paints = 0
    loop.add({ vial, paint: () => paints++ })
    advance(2)
    expect(state.frames).toBe(1)
    expect(paints).toBe(1)
    expect(pending()).toBe(0)
  })

  test("nothing waiting: once the answer settles, no frame is pending", () => {
    const { env, advance, pending } = fakeEnv()
    const loop = createVialLoop(env)
    const vial = new Vial("dec")
    vial.setN(1)
    loop.add({ vial, paint: () => {} })
    vial.answer(false)
    loop.wake()
    advance(8)
    expect(vial.N).toBe(0)
    expect(pending()).toBe(0)
    expect(loop.running()).toBe(false)
  })

  test("still (covered, unfocused, hidden or reduced motion): a change is one frame at its level, no animation", () => {
    const { env, state, advance, pending } = fakeEnv()
    const loop = createVialLoop(env)
    const vial = new Vial("design")
    vial.setN(1)
    let paints = 0
    loop.add({ vial, paint: () => paints++ })
    advance(0.1)
    state.still = true
    state.frames = 0
    paints = 0
    vial.arrive(false)
    loop.wake()
    advance(3)
    expect(state.frames).toBe(1)
    expect(paints).toBe(1)
    expect(vial.drops).toHaveLength(0)
    expect(vial.L).toBeCloseTo(fill(2))
    expect(pending()).toBe(0)
  })

  test("settle in the middle of a gesture: the tube goes to its level, drawn once, and nothing stays pending", () => {
    const { env, state, advance, pending } = fakeEnv()
    const loop = createVialLoop(env)
    const vial = new Vial("design")
    vial.setN(1)
    loop.add({ vial, paint: () => {} })
    vial.arrive(false)
    loop.wake()
    advance(0.3)
    expect(loop.running()).toBe(true)
    state.still = true
    loop.settle()
    expect(pending()).toBe(0)
    expect(vial.L).toBeCloseTo(fill(2))
    expect(vial.shownN).toBe(2)
    state.frames = 0
    advance(3)
    expect(state.frames).toBe(0)
  })

  test("back in front after a change made while still: no replay, the picture is already right", () => {
    const { env, state, advance } = fakeEnv()
    const loop = createVialLoop(env)
    const vial = new Vial("design")
    vial.setN(1)
    loop.add({ vial, paint: () => {} })
    state.still = true
    vial.arrive(false)
    loop.wake()
    advance(1)
    state.still = false
    state.frames = 0
    loop.wake()
    advance(3)
    expect(state.frames).toBe(1)
  })

  test("the last button removed stops the loop", () => {
    const { env, advance } = fakeEnv()
    const loop = createVialLoop(env)
    const vial = new Vial("design")
    vial.setN(1)
    const remove = loop.add({ vial, paint: () => {} })
    vial.arrive(false)
    loop.wake()
    advance(0.5)
    remove()
    expect(loop.running()).toBe(false)
  })
})

describe("the glass", () => {
  test("the wall is at least one full pixel at 20 and 26 px, at every scale", () => {
    for (const [cssW, cssH] of [
      [10, 16],
      [12, 21],
    ] as const) {
      for (const dpr of [1, 1.25, 1.5, 2]) {
        const g = vialGeometry(Math.round(cssW * dpr), Math.round(cssH * dpr), dpr)
        expect(g.wall).toBeGreaterThanOrEqual(g.u)
        expect(g.x1 - g.x0).toBeGreaterThan(0)
      }
    }
  })

  test("the lip is never narrower than the tube, and wider from two device pixels per CSS pixel", () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      const w = Math.round(12 * dpr)
      const g = vialGeometry(w, Math.round(21 * dpr), dpr)
      const lip = w - 2 * g.lipW + 2 * Math.max(0, g.u - 1)
      const tube = g.x1 + g.wall - (g.x0 - g.wall)
      expect(lip).toBeGreaterThanOrEqual(tube)
      if (g.u >= 2) expect(lip).toBeGreaterThan(tube)
    }
  })

  test("the liquid fills the tube below its level and nothing above it; an empty tube draws no liquid", () => {
    const w = 24
    const h = 42
    const vial = new Vial("design")
    vial.setN(3)
    const data = new Uint8ClampedArray(w * h * 4)
    shadeLiquid(data, w, h, 2, vial, "dark")
    const g = vialGeometry(w, h, 2)
    const level = g.bottom - vial.L * (g.bottom - g.top)
    const alpha = (x: number, y: number) => data[(y * w + x) * 4 + 3]!
    const mid = Math.floor((g.x0 + g.x1) / 2)
    expect(alpha(mid, Math.floor(level) + 3)).toBeGreaterThan(200)
    expect(alpha(mid, Math.floor(level) - 3)).toBe(0)
    expect(alpha(0, h - 1)).toBe(0)

    const empty = new Uint8ClampedArray(w * h * 4)
    const none = new Vial("dec")
    none.setN(0)
    shadeLiquid(empty, w, h, 2, none, "light")
    expect(empty.some((value, i) => i % 4 === 3 && value !== 0)).toBe(false)
  })
})
