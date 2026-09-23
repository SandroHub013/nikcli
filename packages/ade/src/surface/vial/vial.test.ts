import { beforeEach, describe, expect, test } from "bun:test"
import { createVialLoop, IDLE_FPS, type LoopEnv } from "./loop"
import { shadeLiquid, vialGeometry } from "./paint"
import { fill, gearOf, resetVialsForTests, Surface, Vial, vialFor } from "./sim"

/* The vial of DS-S62-5 variant 1 in the Design and Decisions buttons (S62). */

/** Steps a vial `seconds` as the loop does at 240 steps a second. */
function run(vial: Vial, seconds: number, reduced = false) {
  const h = 1 / 240
  for (let t = 0; t < seconds; t += h) vial.step(h, reduced)
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

describe("the three gears", () => {
  test("a gesture runs at full rate; at rest with something waiting, the slow rate; nothing waiting, still", () => {
    const vial = new Vial("design")
    vial.setN(2)
    expect(gearOf(vial, false)).toBe(1)
    vial.arrive(false)
    expect(gearOf(vial, false)).toBe(2)
    vial.setN(0)
    expect(gearOf(vial, false)).toBe(0)
  })

  test("with reduced motion nothing moves at rest, even with items waiting", () => {
    const vial = new Vial("dec")
    vial.setN(3)
    expect(gearOf(vial, true)).toBe(0)
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

/** A fake clock: frames and timers run when `advance` passes their time. */
function fakeEnv() {
  let now = 0
  let nextId = 1
  const rafs = new Map<number, (now: number) => void>()
  const timers = new Map<number, { at: number; callback: () => void }>()
  const state = { hidden: false, reduced: false, frames: 0 }
  const env: LoopEnv = {
    raf: (callback) => {
      const id = nextId++
      rafs.set(id, callback)
      return id
    },
    cancelRaf: (id) => void rafs.delete(id),
    timeout: (callback, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    cancelTimeout: (id) => void timers.delete(id),
    hidden: () => state.hidden,
    reduced: () => state.reduced,
  }
  /** Moves the clock in display frames of 1/60 s; each frame runs what is due. */
  const advance = (seconds: number) => {
    const end = now + seconds * 1000
    while (now < end - 1e-6) {
      now += 1000 / 60
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
      const due = [...rafs]
      rafs.clear()
      for (const [, callback] of due) {
        state.frames++
        callback(now)
      }
    }
  }
  return { env, state, advance, pending: () => rafs.size + timers.size }
}

describe("the loop", () => {
  test("a gesture draws at the display's rate, then rest goes to about 20 fps on a timer", () => {
    const { env, state, advance } = fakeEnv()
    const loop = createVialLoop(env)
    const vial = new Vial("design")
    vial.setN(1)
    let paints = 0
    loop.add({ vial, paint: () => paints++ })
    vial.arrive(false)
    loop.wake()
    advance(1)
    expect(state.frames).toBeGreaterThanOrEqual(55)
    // Past the gesture (2.6 s): the rest rate.
    advance(3)
    state.frames = 0
    paints = 0
    advance(2)
    expect(state.frames / 2).toBeGreaterThan(12)
    expect(state.frames / 2).toBeLessThanOrEqual(IDLE_FPS)
    expect(paints).toBe(state.frames)
  })

  test("nothing waiting: once settled, no frame and no timer is pending", () => {
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

  test("hidden window: still, and back at once when shown", () => {
    const { env, state, advance } = fakeEnv()
    const loop = createVialLoop(env)
    const vial = new Vial("design")
    vial.setN(2)
    loop.add({ vial, paint: () => {} })
    state.hidden = true
    loop.sleep()
    state.frames = 0
    advance(2)
    expect(state.frames).toBe(0)
    expect(loop.running()).toBe(false)
    state.hidden = false
    loop.wake()
    advance(1)
    expect(state.frames).toBeGreaterThan(0)
  })

  test("reduced motion: every tube goes to its level and the loop stops, items waiting or not", () => {
    const { env, state, advance } = fakeEnv()
    const loop = createVialLoop(env)
    const vial = new Vial("design")
    vial.setN(2)
    loop.add({ vial, paint: () => {} })
    advance(0.5)
    state.reduced = true
    loop.settle()
    advance(1)
    expect(loop.running()).toBe(false)
    state.frames = 0
    advance(2)
    expect(state.frames).toBe(0)
  })

  test("the last button removed stops the loop", () => {
    const { env, advance } = fakeEnv()
    const loop = createVialLoop(env)
    const vial = new Vial("design")
    vial.setN(2)
    const remove = loop.add({ vial, paint: () => {} })
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
