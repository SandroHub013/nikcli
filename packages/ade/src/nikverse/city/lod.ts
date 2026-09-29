/**
 * How much of a person is worth drawing, by how far they are from the camera.
 *
 * Near, the whole figure at every frame. Past 15 m the pose is worked out ten
 * times a second (nobody sees the difference from there). Past 30 m the figure
 * is one box, an impostor, with no joints at all.
 */

export type Detail = "full" | "slow" | "impostor"

export const SLOW_BEYOND = 15
export const IMPOSTOR_BEYOND = 30
/** Between two pose updates of a person who is far away: ten a second. */
export const SLOW_POSE_MS = 100

export function detailAt(distance: number): Detail {
  if (distance > IMPOSTOR_BEYOND) return "impostor"
  return distance > SLOW_BEYOND ? "slow" : "full"
}

/** Whether the pose is due at `now`, given when it was last worked out (both in seconds). */
export function poseDue(detail: Detail, now: number, last: number): boolean {
  if (detail === "impostor") return false
  if (detail === "full") return true
  return (now - last) * 1000 >= SLOW_POSE_MS
}

/** Whether a shop's sphere (centre and radius on the ground) may be seen: within `range`, and not behind the camera's side. */
export function shopInRange(camera: { x: number; z: number }, shop: { x: number; z: number }, radius: number, range = 140): boolean {
  return Math.hypot(camera.x - shop.x, camera.z - shop.z) - radius <= range
}
