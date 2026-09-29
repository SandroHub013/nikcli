/**
 * The joints of a placeholder person for each pose, as numbers.
 *
 * Angles are radians. An arm hangs down from the shoulder; `armX` turns it
 * about the shoulder's x axis, and -π/2 points it straight forward, -π straight up.
 * The placeholders are made of boxes, so a pose is only these few angles; the
 * animated parts (typing, waving) are added on top by time.
 */

import type { Pose } from "./states"

export interface Joints {
  armLx: number
  armLz: number
  armRx: number
  armRz: number
  /** Torso lean about the hips; negative leans back. */
  torsoX: number
  headX: number
  headY: number
  /** The whole body turned about its own vertical axis (turning to look behind). */
  bodyYaw: number
}

const REST: Joints = { armLx: -0.9, armLz: 0.12, armRx: -0.9, armRz: -0.12, torsoX: 0, headX: 0, headY: 0, bodyYaw: 0 }

const BASE: Readonly<Record<Pose, Joints>> = {
  type: { ...REST, armLx: -1.3, armRx: -1.3, headX: 0.12 },
  "raise-hand": { ...REST, armLx: -0.9, armRx: -2.9, armRz: -0.2 },
  turn: { ...REST, bodyYaw: 1.05, headY: 0.35 },
  "head-hands": { ...REST, armLx: -2.45, armLz: 0.35, armRx: -2.45, armRz: -0.35, headX: 0.65, torsoX: 0.18 },
  "lean-back": { ...REST, armLx: -2.6, armLz: 0.55, armRx: -2.6, armRz: -0.55, torsoX: -0.32, headX: -0.1 },
  sit: REST,
  away: REST,
}

/** The joints of a pose at time `t` seconds: the resting pose plus whatever moves in it. */
export function jointsFor(pose: Pose, t: number): Joints {
  const j = { ...BASE[pose] }
  switch (pose) {
    case "type":
      j.armLx += Math.sin(t * 17) * 0.09
      j.armRx += Math.sin(t * 17 + Math.PI) * 0.09
      j.headX += Math.sin(t * 2.3) * 0.03
      break
    case "raise-hand":
      j.armRz += Math.sin(t * 6) * 0.35
      break
    case "turn":
      j.headY += Math.sin(t * 1.4) * 0.12
      break
    case "head-hands":
      j.headX += Math.sin(t * 1.1) * 0.03
      break
    case "sit":
    case "lean-back":
      j.torsoX += Math.sin(t * 1.6) * 0.012
      break
  }
  return j
}

/** Between two sets of joints: `k` 0 is `a`, 1 is `b`. */
export function mixJoints(a: Joints, b: Joints, k: number): Joints {
  const m = (x: number, y: number) => x + (y - x) * k
  return {
    armLx: m(a.armLx, b.armLx),
    armLz: m(a.armLz, b.armLz),
    armRx: m(a.armRx, b.armRx),
    armRz: m(a.armRz, b.armRz),
    torsoX: m(a.torsoX, b.torsoX),
    headX: m(a.headX, b.headX),
    headY: m(a.headY, b.headY),
    bodyYaw: m(a.bodyYaw, b.bodyYaw),
  }
}

/** The walk cycle's leg and arm swing, from the speed in m/s and the time. */
export function walkSwing(speed: number, t: number): { leg: number; arm: number } {
  if (speed < 0.05) return { leg: 0, arm: 0 }
  const amplitude = Math.min(0.75, 0.25 + speed * 0.1)
  const s = Math.sin(t * (4 + speed * 1.6))
  return { leg: s * amplitude, arm: -s * amplitude * 0.8 }
}
