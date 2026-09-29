/**
 * `WebGPURenderer.init()` starts a loop of its own on `requestAnimationFrame` and never stops it: at every frame of the
 * display it advances the node clock and resets the counters, whether or not anything is drawn. A city that has gone to
 * sleep (nothing drawn, no timer of its own) was still woken 60 times a second, and the renderer of the frame and the GPU
 * process paid for each (about 1 to 2.6 % of a core, seen in a browser trace of the frame at rest).
 *
 * This stops that loop and does its two jobs where they belong, once per `render` call: the counters reset and the node
 * clock (`nodeFrame.update`) advance before the scene is drawn. A render inside a render (three's own passes) is one frame.
 * The classic `WebGLRenderer` has no such loop and is not touched. It relies on three's internals (`_animation`, `_nodes`,
 * `info`): if they are not there it does nothing and says so, and the city works as before.
 */

interface Loop {
  _animation?: { stop(): void } | null
  _nodes?: { nodeFrame?: { update(): void; frameId: number } }
  info?: { autoReset?: boolean; reset(): void; frame: number }
  render(scene: unknown, camera: unknown): void
}

/** Returns whether the internal loop was stopped. */
export function quietLoop(renderer: unknown): boolean {
  const r = renderer as Loop
  const animation = r._animation
  const frame = r._nodes?.nodeFrame
  const info = r.info
  if (!animation || typeof animation.stop !== "function" || !frame || typeof frame.update !== "function" || !info)
    return false
  animation.stop()
  const render = r.render.bind(r)
  let depth = 0
  r.render = (scene, camera) => {
    if (depth === 0) {
      if (info.autoReset === true) info.reset()
      frame.update()
      info.frame = frame.frameId
    }
    depth++
    try {
      render(scene, camera)
    } finally {
      depth--
    }
  }
  return true
}
