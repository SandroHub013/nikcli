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

export function drawMode(state: { moving: boolean; sinceActivityMs: number }): DrawMode {
  if (state.moving) return "moving"
  return state.sinceActivityMs >= IMMOBILE_AFTER_MS ? "immobile" : "still"
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
