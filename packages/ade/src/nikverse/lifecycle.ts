/**
 * When the world runs, sleeps and is let go.
 *
 * A 3D world in a WebView costs memory and a GPU, and a panel nobody can see
 * must cost ADE nothing. So: while the panel is visible the world runs; the
 * moment it is not, ADE tells it to `pause` (it stops asking for frames);
 * after `UNLOAD_AFTER_MS` of that ADE unloads the frame altogether, which
 * gives back its process, its memory and its GPU; and when the panel comes
 * back the frame is loaded again and starts from a fresh snapshot.
 *
 * Kept apart from the panel so the clock can be tested with a fake one.
 */

/** How long a hidden world is paused before its frame is taken away. */
export const UNLOAD_AFTER_MS = 5 * 60_000

export type WorldPhase = "running" | "paused" | "unloaded"

export interface LifecycleIo {
  /** Tell the world to stop drawing. */
  pause(): void
  /** Tell the world to draw again (and ADE sends the picture again). */
  resume(): void
  /** Take the frame away: nothing of the world is left running. */
  unload(): void
  /** Bring the frame back, from nothing. */
  load(): void
  /** Runs `run` after `ms`; the returned function cancels it. */
  schedule(run: () => void, ms: number): () => void
}

/** The world starts `running`: the panel that creates it is on screen. */
export function createLifecycle(io: LifecycleIo) {
  let phase: WorldPhase = "running"
  let cancel: (() => void) | undefined

  const stopClock = () => {
    cancel?.()
    cancel = undefined
  }

  return {
    phase: (): WorldPhase => phase,
    setVisible(visible: boolean) {
      if (visible) {
        if (phase === "running") return
        stopClock()
        const wasUnloaded = phase === "unloaded"
        phase = "running"
        if (wasUnloaded) io.load()
        else io.resume()
        return
      }
      if (phase !== "running") return
      phase = "paused"
      io.pause()
      cancel = io.schedule(() => {
        cancel = undefined
        phase = "unloaded"
        io.unload()
      }, UNLOAD_AFTER_MS)
    },
    /** The panel is closed: no clock is left behind. */
    dispose() {
      stopClock()
    },
  }
}
