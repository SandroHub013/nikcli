/**
 * The character against the buildings: a circle on the ground against oriented
 * boxes. No physics, only "do not stand inside a wall".
 *
 * A move is cut into steps shorter than the thinnest wall, so a fast character
 * cannot cross one between two frames.
 */

import type { Box, Vec2 } from "./layout"

/** Pushes a circle out of a box, or returns it unchanged when it does not touch it. */
export function pushOut(p: Vec2, radius: number, box: Box): Vec2 {
  const s = Math.sin(box.yaw)
  const c = Math.cos(box.yaw)
  // The point in the box's own frame (the inverse of the yaw used by `toWorld`).
  const dx = p.x - box.cx
  const dz = p.z - box.cz
  const lx = dx * c - dz * s
  const lz = dx * s + dz * c
  const qx = Math.max(-box.hx, Math.min(box.hx, lx))
  const qz = Math.max(-box.hz, Math.min(box.hz, lz))
  let nx = lx - qx
  let nz = lz - qz
  const dist = Math.hypot(nx, nz)
  let ox: number
  let oz: number
  if (dist >= radius) return p
  if (dist > 1e-9) {
    ox = qx + (nx / dist) * radius
    oz = qz + (nz / dist) * radius
  } else {
    // The centre is inside the box: leave by the nearest side.
    const left = lx + box.hx
    const right = box.hx - lx
    const back = lz + box.hz
    const front = box.hz - lz
    const least = Math.min(left, right, back, front)
    ox = lx
    oz = lz
    if (least === left) ox = -box.hx - radius
    else if (least === right) ox = box.hx + radius
    else if (least === back) oz = -box.hz - radius
    else oz = box.hz + radius
  }
  nx = ox
  nz = oz
  // Back to the world.
  return { x: box.cx + nx * c + nz * s, z: box.cz - nx * s + nz * c }
}

export interface World {
  boxes: ReadonlyArray<Box>
  /** The ground the character may walk on: a disc around the square. */
  radius: number
}

/** The thinnest thing a step must not skip. */
const MAX_STEP = 0.15

function settle(p: Vec2, radius: number, world: World): Vec2 {
  let at = p
  // A few passes: leaving one box can push into the next (a corner, or the narrow aisle between two desks).
  for (let pass = 0; pass < 8; pass++) {
    for (const box of world.boxes) at = pushOut(at, radius, box)
  }
  const d = Math.hypot(at.x, at.z)
  const limit = world.radius - radius
  if (d > limit) at = { x: (at.x / d) * limit, z: (at.z / d) * limit }
  return at
}

/** Moves a circle by `delta`, sliding along what it meets. */
export function moveWithCollisions(from: Vec2, delta: Vec2, radius: number, world: World): Vec2 {
  const length = Math.hypot(delta.x, delta.z)
  const steps = Math.max(1, Math.ceil(length / MAX_STEP))
  let at = from
  for (let i = 0; i < steps; i++) {
    at = settle({ x: at.x + delta.x / steps, z: at.z + delta.z / steps }, radius, world)
  }
  return at
}

/** Whether a circle overlaps any box. */
export function blocked(p: Vec2, radius: number, world: World): boolean {
  return world.boxes.some((box) => {
    const q = pushOut(p, radius, box)
    return q !== p
  })
}
