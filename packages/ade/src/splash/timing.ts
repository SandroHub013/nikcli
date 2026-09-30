/**
 * How long the startup screen stays up, and when its scene starts.
 *
 * Pure, so the numbers are tested and the workbench and the splash read the same ones.
 */

/**
 * The shortest time the startup screen stays up.
 *
 * A warm start finishes in under a tenth of a second, and a screen that appears and vanishes in that time
 * reads as a glitch. Long enough to be looked at, short enough not to be waited for: a floor and not a delay,
 * so a start that really takes longer keeps the screen up until it is over.
 */
export const SPLASH_FLOOR_MS = 1500

/**
 * How long the splash waits before it builds its WebGL scene. A boot that is over sooner never loads
 * three.js (729 kB) nor takes a GPU context for a screen that is already going; until then it is the dark
 * background with the status line.
 */
export const SPLASH_SCENE_DELAY_MS = 300

/** How much of the floor is left `now`, for a start that began at `startedAt` (both in ms; never negative). */
export function splashRemainingMs(startedAt: number, now: number, floor = SPLASH_FLOOR_MS): number {
  return Math.max(0, floor - (now - startedAt))
}
