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

/** A frame later than this after the one before, at a level that draws at 60, is a slow one (old PCs, point 2). */
export const SLOW_FRAME_MS = 25
/** More slow frames than this share of a second is a second whose p95 is above `SLOW_FRAME_MS`. */
export const SLOW_SHARE = 0.05
/** That many such seconds in a row while moving, and the level is too much for the machine. */
export const SLOW_SECONDS = 10

/**
 * Whether the machine keeps up with a 60 fps level: fed the moving mode's frames one by one (the time since the frame
 * before), it says yes once, when ten seconds of moving in a row had a p95 above 25 ms. Still and immobile time is not
 * fed: there the frames are slow on purpose. `pause` drops the second in progress, not the run of slow seconds.
 */
export function createSlowWatch() {
  let elapsed = 0
  let frames = 0
  let slow = 0
  let run = 0
  let said = false
  return {
    push(ms: number): boolean {
      if (said) return false
      elapsed += ms
      frames++
      if (ms > SLOW_FRAME_MS) slow++
      if (elapsed < 1000) return false
      run = slow / frames > SLOW_SHARE ? run + 1 : 0
      elapsed = frames = slow = 0
      if (run < SLOW_SECONDS) return false
      said = true
      return true
    },
    pause() {
      elapsed = frames = slow = 0
    },
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
