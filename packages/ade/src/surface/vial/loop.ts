/**
 * One loop for every vial, in three gears (S62).
 *
 * 60 fps while a gesture runs; about 20 at rest with something waiting, since
 * the rest motion is slow; still — no frame, no timer — when nothing waits,
 * when the window is hidden, and with reduced motion. At rest the next frame
 * is asked for by a timer rather than by skipping animation frames, so the
 * page is not woken sixty times a second to do nothing.
 */

import { gearOf, type Vial } from "./sim"

/** The rest rate asked for; frames land on the display's, so about 20 in practice. */
export const IDLE_FPS = 24

export interface VialView {
  vial: Vial
  /** Draws the tube; `force` after a resize or a theme change. */
  paint: () => void
  force?: boolean
}

export interface LoopEnv {
  raf: (callback: (now: number) => void) => number
  cancelRaf: (id: number) => void
  timeout: (callback: () => void, ms: number) => number
  cancelTimeout: (id: number) => void
  hidden: () => boolean
  reduced: () => boolean
}

export interface VialLoop {
  /** Adds a view and draws it; the returned function removes it. */
  add: (view: VialView) => () => void
  /** Something changed (a count, the theme, the window shown again): look again. */
  wake: () => void
  /** Reduced motion was switched on or off: every tube goes to its level at once. */
  settle: () => void
  /** The window was hidden: nothing pending until `wake`. */
  sleep: () => void
  /** Whether a frame or a timer is pending: false means the loop costs nothing. */
  running: () => boolean
}

export function createVialLoop(env: LoopEnv): VialLoop {
  const views = new Set<VialView>()
  let raf = 0
  let timer = 0
  let last = 0

  const vials = () => new Set([...views].map((view) => view.vial))

  const draw = () => {
    for (const view of views) {
      if (view.vial.dirty || view.force) {
        view.paint()
        view.force = false
      }
    }
    for (const vial of vials()) vial.dirty = false
  }

  const halt = () => {
    if (raf) env.cancelRaf(raf)
    if (timer) env.cancelTimeout(timer)
    raf = timer = last = 0
  }

  const frame = (now: number) => {
    raf = 0
    if (env.hidden() || views.size === 0) {
      last = 0
      return
    }
    const reduced = env.reduced()
    let gear = 0
    for (const vial of vials()) gear = Math.max(gear, gearOf(vial, reduced))
    if (gear === 0) {
      draw()
      last = 0
      return
    }
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 1 / 60)
    last = now
    for (const vial of vials()) {
      if (!gearOf(vial, reduced)) continue
      const steps = Math.ceil(dt * 240)
      for (let i = 0; i < steps; i++) vial.step(dt / steps, reduced)
      vial.gesture = Math.max(0, vial.gesture - dt)
    }
    draw()
    let next = 0
    for (const vial of vials()) next = Math.max(next, gearOf(vial, reduced))
    if (next === 2) raf = env.raf(frame)
    else if (next === 1) {
      timer = env.timeout(() => {
        timer = 0
        raf = env.raf(frame)
      }, 1000 / IDLE_FPS)
    } else {
      // Settled: one more frame paints the exact level `moving` left, then nothing.
      raf = env.raf(frame)
    }
  }

  const wake = () => {
    if (views.size === 0 || env.hidden()) return
    // A pending rest timer would make a new gesture wait for it.
    if (timer) {
      env.cancelTimeout(timer)
      timer = 0
    }
    if (!raf) raf = env.raf(frame)
  }

  return {
    add(view) {
      view.force = true
      views.add(view)
      wake()
      return () => {
        views.delete(view)
        if (views.size === 0) halt()
      }
    },
    wake,
    settle() {
      for (const vial of vials()) vial.snap()
      wake()
    },
    sleep: halt,
    running: () => raf !== 0 || timer !== 0,
  }
}
