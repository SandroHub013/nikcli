/**
 * One loop for every vial (S62).
 *
 * Frames only while a tube is moving: the few seconds of a gesture after a
 * count changes, and its settling. At rest — with items waiting or not — the
 * tube is a still picture and nothing is pending: no frame, no timer.
 *
 * Nor while ADE is not being looked at. WebView2 does not set
 * `document.hidden` when the window is covered (measured, Verifiche
 * 2026-09-24), so the signal is the window's focus, from the host: without it
 * a change is shown at once, as with reduced motion, in one frame.
 */

import { animating, type Vial } from "./sim"

export interface VialView {
  vial: Vial
  /** Draws the tube; `force` after a resize or a theme change. */
  paint: () => void
  force?: boolean
}

export interface LoopEnv {
  raf: (callback: (now: number) => void) => number
  cancelRaf: (id: number) => void
  /** True when nothing should move: the page hidden, the window without focus, or reduced motion. */
  still: () => boolean
}

export interface VialLoop {
  /** Adds a view and draws it; the returned function removes it. */
  add: (view: VialView) => () => void
  /** Something changed (a count, the theme, the window back in front): look again. */
  wake: () => void
  /** Stop moving: every tube goes to where it is heading, drawn once, and nothing stays pending. */
  settle: () => void
  /** Whether a frame is pending: false means the loop costs nothing. */
  running: () => boolean
}

export function createVialLoop(env: LoopEnv): VialLoop {
  const views = new Set<VialView>()
  let raf = 0
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

  /** Every moving tube straight to its level, and the picture drawn. */
  const snapAll = () => {
    for (const vial of vials()) if (vial.gesture > 0 || vial.drops.length > 0 || animating(vial)) vial.snap()
    draw()
  }

  const frame = (now: number) => {
    raf = 0
    if (views.size === 0) return
    if (env.still()) {
      snapAll()
      last = 0
      return
    }
    const moving = [...vials()].filter(animating)
    if (moving.length === 0) {
      draw()
      last = 0
      return
    }
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 1 / 60)
    last = now
    for (const vial of moving) {
      const steps = Math.ceil(dt * 240)
      for (let i = 0; i < steps; i++) vial.step(dt / steps)
      vial.gesture = Math.max(0, vial.gesture - dt)
    }
    draw()
    // Once settled, one more frame paints the exact level `moving` left, then nothing.
    raf = env.raf(frame)
  }

  const wake = () => {
    if (views.size === 0) return
    if (!raf) raf = env.raf(frame)
  }

  return {
    add(view) {
      view.force = true
      views.add(view)
      wake()
      return () => {
        views.delete(view)
        if (views.size === 0 && raf) {
          env.cancelRaf(raf)
          raf = last = 0
        }
      }
    },
    wake,
    settle() {
      if (raf) env.cancelRaf(raf)
      raf = last = 0
      if (views.size > 0) snapAll()
    },
    running: () => raf !== 0,
  }
}
