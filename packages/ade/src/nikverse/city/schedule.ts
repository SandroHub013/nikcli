/**
 * When the city draws, and when it tells ADE where the character is.
 *
 * Three ways to draw, because the limit is the CPU: while something moves it
 * draws every frame; while the character stands and only the hologram turns it
 * draws 15 times a second; and once nothing has happened for ten seconds it
 * draws nothing until an event (a key, the mouse, ADE's picture, a resize).
 */

export type DrawMode = "moving" | "still" | "immobile"

/** The frame interval of the resting mode: 15 frames a second. */
export const STILL_INTERVAL_MS = 66
/** Quiet for this long, and the city stops drawing until something happens. */
export const IMMOBILE_AFTER_MS = 10_000

/**
 * The quiet time when the frames are drawn in software (no GPU: SwiftShader and the like). There a still frame costs
 * as much as a moving one, three to five processors at 15 a second (old PCs, point 1): the city rests as soon as the
 * camera has settled, and the light and the water stop with it until an event.
 */
export const SOFTWARE_IMMOBILE_AFTER_MS = 1500

export function drawMode(state: { moving: boolean; sinceActivityMs: number }, immobileAfterMs = IMMOBILE_AFTER_MS): DrawMode {
  if (state.moving) return "moving"
  return state.sinceActivityMs >= immobileAfterMs ? "immobile" : "still"
}

/**
 * At 60 Hz a frame later than this after the one before is a slow one (old PCs, point 2): one and a half vsyncs, so a
 * missed vsync. On another display the vsync is its own (`push`'s second argument), never longer than 60 Hz's.
 */
export const SLOW_FRAME_MS = 25
/** The longest vsync the watch assumes: a display slower than 60 Hz is treated as 60 Hz. */
export const VSYNC_60_MS = 1000 / 60
/** More slow frames than this share of the window is a p95 above `SLOW_FRAME_MS`. */
export const SLOW_SHARE = 0.05
/** The window, in seconds of moving: over the last ten, a p95 above 25 ms and the level is too much for the machine. */
export const SLOW_SECONDS = 10

/**
 * Whether the machine keeps up with a 60 fps level: fed every display frame of the moving mode (the time since the one
 * before, and the display's vsync), it says yes once, when the last ten seconds of moving, taken as one window, missed
 * vsyncs on more than one frame in twenty: at 60 Hz, a p95 above 25 ms. One window and not ten seconds each over the
 * line: a machine near the line has its good and bad seconds, and a single good one used to start the count again. A frame that came on its vsync is never slow, so a 75 or 144 Hz display
 * pacing 60 fps (draws 13.3 or 26.7 ms apart, but a callback on every vsync) is not taken for a slow machine. Still and
 * immobile time is not fed: there the frames are slow on purpose. `pause` drops the second in progress, not the run.
 */
export function createSlowWatch() {
  let elapsed = 0
  let frames = 0
  let slow = 0
  /** The last `SLOW_SECONDS` whole seconds of moving: frames, and slow ones. */
  const seconds: { frames: number; slow: number }[] = []
  let said = false
  const share = () => {
    const total = seconds.reduce((sum, s) => sum + s.frames, 0)
    return total ? seconds.reduce((sum, s) => sum + s.slow, 0) / total : 0
  }
  return {
    push(ms: number, vsyncMs = VSYNC_60_MS): boolean {
      if (said) return false
      elapsed += ms
      frames++
      if (ms > 1.5 * Math.min(vsyncMs, VSYNC_60_MS)) slow++
      if (elapsed < 1000) return false
      seconds.push({ frames, slow })
      if (seconds.length > SLOW_SECONDS) seconds.shift()
      elapsed = frames = slow = 0
      if (seconds.length < SLOW_SECONDS || share() <= SLOW_SHARE) return false
      said = true
      return true
    },
    pause() {
      elapsed = frames = slow = 0
    },
    /** Where the watch is, for `__nikverseWhy`: the seconds in the window, their share of slow frames, and whether it said so. */
    state: () => ({ seconds: seconds.length, share: Math.round(share() * 1000) / 1000, said }),
  }
}

/** How often the position is sent to ADE while the character walks. */
export const POSITION_EVERY_MS = 3000

/**
 * Whether to send the position now: when the character has just stopped, and
 * every few seconds while it walks, so ADE has the last place it stood at and
 * the world can be unloaded and come back to it.
 */
export function shouldSavePosition(before: { moving: boolean; sentAt: number }, now: { moving: boolean; at: number }): boolean {
  if (before.moving && !now.moving) return true
  return now.moving && now.at - before.sentAt >= POSITION_EVERY_MS
}

/** A frame that arrives this early (ms) still counts as on time: the display's timestamps jitter. */
export const DRAW_JITTER_MS = 1

/**
 * Whether to draw at the display frame `ts`, and when the next draw is due, for a draw every `interval` ms.
 * The due times stay on a grid of `interval`, so the rate on average is exactly the level's, whatever the
 * display's (a 144 Hz display draws every second or third frame, a 75 Hz one nearly every frame); a plain
 * "at least `interval` since the last draw" would settle at 48 fps on 144 Hz and go over 60 with the jitter.
 * A frame that comes long after its due time starts the grid again; a shorter interval (the character starts
 * to walk) does not wait out the longer one.
 */
export function pace(ts: number, next: number, interval: number): { draw: boolean; next: number } {
  const due = next > ts + interval ? ts : next
  if (ts < due - DRAW_JITTER_MS) return { draw: false, next: due }
  return { draw: true, next: ts - due > interval ? ts + interval : due + interval }
}
