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

/**
 * Until when a scene is still worth building, from the moment the splash appeared.
 *
 * three.js is fetched and parsed after the delay, and on a slow disk that can take a second. A scene that
 * shows up then is on screen for a moment and goes with the splash, at the price of a GPU context and a
 * frame loop that nobody looks at. Past this the screen stays what it already is: the dark background with
 * the status line. Between the delay and the floor, so the scene has time to arrive and the floor time to end.
 */
export const SPLASH_SCENE_DEADLINE_MS = 1100

/** Whether a scene that is ready `now`, for a splash that appeared at `startedAt` (both in ms), is still worth building. */
export function sceneIsWorthBuilding(startedAt: number, now: number, deadline = SPLASH_SCENE_DEADLINE_MS): boolean {
  return now - startedAt < deadline
}

/** How much of the floor is left `now`, for a start that began at `startedAt` (both in ms; never negative). */
export function splashRemainingMs(startedAt: number, now: number, floor = SPLASH_FLOOR_MS): number {
  return Math.max(0, floor - (now - startedAt))
}
