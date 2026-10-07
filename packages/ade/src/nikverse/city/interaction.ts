/**
 * What the user can press: the computer of a session, the Faro's door and the games' kiosk, by a click on it or by
 * `E` next to it. A computer opens its session (`open-session`); a place opens the lessons or the game
 * (`open-learn`, with the place and nothing else: what opens is ADE's).
 *
 * The click is a ray: it picks something only if no wall is in front of it, so a click at a computer on the other
 * side of a shop's wall, or at the Faro's door from behind the tower, does nothing.
 */

import type { LearnPlace } from "../protocol"
import type { Box, Vec2 } from "./layout"

/** Where a pickable is, and the size of the target for the click. */
interface Target {
  x: number
  y: number
  z: number
  radius: number
}

/** A session's computer (or, for someone standing, the person). */
export type SessionPickable = Target & { kind: "session"; paneId: string }
/** One of the places where one learns: the Faro's door, the kiosk's counter. */
export type PlacePickable = Target & { kind: "place"; place: LearnPlace }
/** Something the ray or the key can pick. */
export type Pickable = SessionPickable | PlacePickable

/** What pressing a pickable sends to ADE. */
export type PickCommand = { cmd: "open-session"; paneId: string } | { cmd: "open-learn"; place: LearnPlace }

export function commandOf(item: Pickable): PickCommand {
  return item.kind === "session" ? { cmd: "open-session", paneId: item.paneId } : { cmd: "open-learn", place: item.place }
}

/** A name for a pickable that stays the same while it is the one in reach: the hint changes only when it changes. */
export const pickableKey = (item: Pickable): string => (item.kind === "session" ? `session:${item.paneId}` : `place:${item.place}`)

/** How close the character must be for `E`, in metres on the ground. */
export const REACH = 1.5

export interface Ray {
  ox: number
  oy: number
  oz: number
  /** Unit direction. */
  dx: number
  dy: number
  dz: number
}

/** The nearest pickable within `REACH` of the character, or nothing. */
export function nearestPickable<T extends Pickable>(at: Vec2, list: ReadonlyArray<T>, reach = REACH): T | undefined {
  let best: T | undefined
  let bestDistance = reach
  for (const item of list) {
    const d = Math.hypot(item.x - at.x, item.z - at.z)
    if (d <= bestDistance) {
      best = item
      bestDistance = d
    }
  }
  return best
}

/** The distance along the ray at which it meets a sphere, or nothing. */
export function raySphere(ray: Ray, item: Pickable): number | undefined {
  const lx = item.x - ray.ox
  const ly = item.y - ray.oy
  const lz = item.z - ray.oz
  const t = lx * ray.dx + ly * ray.dy + lz * ray.dz
  if (t < 0) return undefined
  const d2 = lx * lx + ly * ly + lz * lz - t * t
  if (d2 > item.radius * item.radius) return undefined
  return t - Math.sqrt(item.radius * item.radius - d2)
}

/** The distance along the ray at which it meets a wall (a box from the ground up to its height). */
export function rayBox(ray: Ray, box: Box): number | undefined {
  const s = Math.sin(box.yaw)
  const c = Math.cos(box.yaw)
  // Into the box's frame; y stays.
  const px = ray.ox - box.cx
  const pz = ray.oz - box.cz
  const o = [px * c - pz * s, ray.oy, px * s + pz * c]
  const d = [ray.dx * c - ray.dz * s, ray.dy, ray.dx * s + ray.dz * c]
  const lo = [-box.hx, 0, -box.hz]
  const hi = [box.hx, box.height, box.hz]
  let near = 0
  let far = Infinity
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < lo[i] || o[i] > hi[i]) return undefined
      continue
    }
    let a = (lo[i] - o[i]) / d[i]
    let b = (hi[i] - o[i]) / d[i]
    if (a > b) [a, b] = [b, a]
    near = Math.max(near, a)
    far = Math.min(far, b)
    if (near > far) return undefined
  }
  return near
}

/** What a click at `ray` lands on, or nothing when a wall is in the way or nothing is hit. */
export function pickWithRay<T extends Pickable>(
  ray: Ray,
  list: ReadonlyArray<T>,
  walls: ReadonlyArray<Box>,
  farthest = 80,
): T | undefined {
  let best: T | undefined
  let bestT = farthest
  for (const item of list) {
    const t = raySphere(ray, item)
    if (t !== undefined && t < bestT) {
      best = item
      bestT = t
    }
  }
  if (!best) return undefined
  for (const wall of walls) {
    const t = rayBox(ray, wall)
    if (t !== undefined && t < bestT) return undefined
  }
  return best
}

/** The command `E` stands for at this place: pressing what is within reach, the nearest, or nothing. */
export function keyCommand(code: string, at: Vec2, list: ReadonlyArray<Pickable>): PickCommand | undefined {
  if (code !== "KeyE") return undefined
  const near = nearestPickable(at, list)
  return near ? commandOf(near) : undefined
}
