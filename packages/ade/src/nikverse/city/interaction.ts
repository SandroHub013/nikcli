/**
 * What the user can press: the computer of a session, by a click on it or by
 * `E` next to it. Both end in the same command, `open-session`.
 *
 * The click is a ray: it picks a computer only if no wall is in front of it, so
 * a click at a computer on the other side of a shop's wall does nothing.
 */

import type { Box, Vec2 } from "./layout"

/** Something the ray or the key can pick: a session's computer. */
export interface Pickable {
  paneId: string
  x: number
  y: number
  z: number
  /** The size of the target, for the click. */
  radius: number
}

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
export function nearestPickable(at: Vec2, list: ReadonlyArray<Pickable>, reach = REACH): Pickable | undefined {
  let best: Pickable | undefined
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

/** The computer a click at `ray` lands on, or nothing when a wall is in the way or nothing is hit. */
export function pickWithRay(
  ray: Ray,
  list: ReadonlyArray<Pickable>,
  walls: ReadonlyArray<Box>,
  farthest = 80,
): Pickable | undefined {
  let best: Pickable | undefined
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

/** The command `E` stands for at this place: opening the session of the computer within reach, or nothing. */
export function keyCommand(
  code: string,
  at: Vec2,
  list: ReadonlyArray<Pickable>,
): { cmd: "open-session"; paneId: string } | undefined {
  if (code !== "KeyE") return undefined
  const near = nearestPickable(at, list)
  return near ? { cmd: "open-session", paneId: near.paneId } : undefined
}
