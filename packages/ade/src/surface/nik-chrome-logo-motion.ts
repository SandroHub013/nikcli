/**
 * When the title bar's mark may ask for frames, and for how long a hover keeps it moving.
 *
 * The mark sits in the bar for the whole session. Measured on its own (ade-team/results/ade-animazioni-costo.md), its sheen, a
 * stroke that redraws inside a 3D context, cost about 28 % of a core while it ran, for 16x20 pixels; and a pointer left parked on
 * the mark kept its loop and its sheen alive for as long as it stayed there, because «the pointer is inside» was reason enough.
 * The pointer is a reason while it moves. Parked, the springs settle and the loop stops; the next movement wakes it.
 */

/** A pointer that has not moved for this long (ms) no longer keeps the physics loop going. */
export const POINTER_IDLE_MS = 1500

/** One pass of the sheen, in ms: it comes in from the start of the stroke and ends on the resting frame. */
export const SHEEN_MS = 1200

export interface LoopState {
  now: number
  /** The short intro after mount. */
  introUntil: number
  pointerInside: boolean
  /** The time of the last movement, entry or click of the pointer on the mark. */
  lastPointerAt: number
  /** The springs are at rest. */
  settled: boolean
}

/** Whether the physics loop asks for another frame. */
export function loopWanted(s: LoopState): boolean {
  if (s.now < s.introUntil) return true
  if (!s.settled) return true
  return s.pointerInside && s.now - s.lastPointerAt < POINTER_IDLE_MS
}
