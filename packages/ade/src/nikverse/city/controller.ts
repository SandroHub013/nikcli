/**
 * The user's character and the camera behind it, as plain numbers.
 *
 * The camera's `yaw` is the direction it looks in: 0 looks toward -z (three's
 * default), and it grows counter-clockwise seen from above. Keys move the
 * character relative to it: W goes where the camera looks.
 */

import { moveWithCollisions, type World } from "./collision"
import type { Vec2 } from "./layout"

export interface Input {
  forward: boolean
  back: boolean
  left: boolean
  right: boolean
  run: boolean
}

export const NO_INPUT: Input = { forward: false, back: false, left: false, right: false, run: false }

export const WALK_SPEED = 3.2
export const RUN_SPEED = 6.4
/** The character's radius on the ground, for the walls: a chibi is under half a metre across, and the aisle between the desks 0.54. */
export const BODY_RADIUS = 0.22
/** Metres per second the speed changes by: a quick start and stop, not a slide. */
const ACCELERATION = 28

export interface Player {
  x: number
  z: number
  /** The way the body faces. */
  heading: number
  /** Speed in m/s along the heading, for the walk cycle. */
  speed: number
  vx: number
  vz: number
}

export const spawnPlayer = (at: Vec2 = { x: 0, z: 5 }): Player => ({ x: at.x, z: at.z, heading: Math.PI, speed: 0, vx: 0, vz: 0 })

/** The keys that mean an input, by physical position (`code`), so WASD is WASD on every layout. */
export function inputKey(code: string): keyof Input | undefined {
  switch (code) {
    case "KeyW":
    case "ArrowUp":
      return "forward"
    case "KeyS":
    case "ArrowDown":
      return "back"
    case "KeyA":
    case "ArrowLeft":
      return "left"
    case "KeyD":
    case "ArrowRight":
      return "right"
    case "ShiftLeft":
    case "ShiftRight":
      return "run"
    default:
      return undefined
  }
}

/** The wanted direction on the ground (unit length, or zero), relative to where the camera looks. */
export function wantedDirection(input: Input, cameraYaw: number): Vec2 {
  const f = (input.forward ? 1 : 0) - (input.back ? 1 : 0)
  const r = (input.right ? 1 : 0) - (input.left ? 1 : 0)
  if (f === 0 && r === 0) return { x: 0, z: 0 }
  // Forward is (-sin yaw, -cos yaw); right is that turned a quarter clockwise, (cos yaw, -sin yaw).
  const x = -Math.sin(cameraYaw) * f + Math.cos(cameraYaw) * r
  const z = -Math.cos(cameraYaw) * f - Math.sin(cameraYaw) * r
  const length = Math.hypot(x, z)
  return { x: x / length, z: z / length }
}

/** The angle `to` is from `from`, the short way round. */
export function turnToward(from: number, to: number, maxStep: number): number {
  let d = (to - from) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return from + Math.max(-maxStep, Math.min(maxStep, d))
}

/** Advances the character by `dt` seconds. */
export function stepPlayer(p: Player, input: Input, cameraYaw: number, dt: number, world: World): Player {
  const dir = wantedDirection(input, cameraYaw)
  const top = input.run ? RUN_SPEED : WALK_SPEED
  const want = { x: dir.x * top, z: dir.z * top }
  const dvx = want.x - p.vx
  const dvz = want.z - p.vz
  const dv = Math.hypot(dvx, dvz)
  const limit = ACCELERATION * dt
  const k = dv > limit ? limit / dv : 1
  const vx = p.vx + dvx * k
  const vz = p.vz + dvz * k
  const to = moveWithCollisions({ x: p.x, z: p.z }, { x: vx * dt, z: vz * dt }, BODY_RADIUS, world)
  const speed = Math.hypot(vx, vz)
  const heading = speed > 0.2 ? turnToward(p.heading, Math.atan2(vx, vz), 14 * dt) : p.heading
  return { x: to.x, z: to.z, heading, speed, vx, vz }
}

export interface Orbit {
  yaw: number
  /** Elevation of the camera above the character's height, in radians. */
  pitch: number
  distance: number
}

export const MIN_PITCH = 0.12
export const MAX_PITCH = 1.25
export const MIN_DISTANCE = 3
export const MAX_DISTANCE = 12
export const startOrbit = (): Orbit => ({ yaw: 0, pitch: 0.3, distance: 8 })

/** The mouse turns the camera: right turns right, down looks down (the camera rises). */
export function lookAround(o: Orbit, dx: number, dy: number, sensitivity = 0.0025, invertY = false): Orbit {
  const pitch = o.pitch + dy * sensitivity * (invertY ? -1 : 1)
  return { ...o, yaw: o.yaw - dx * sensitivity, pitch: Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch)) }
}

export function zoom(o: Orbit, wheel: number): Orbit {
  return { ...o, distance: Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, o.distance * Math.exp(wheel * 0.001))) }
}

/** Where the camera wants to be: behind the character on the orbit, looking at its shoulders. */
export function cameraGoal(p: Vec2, o: Orbit, focusHeight = 1.4): { eye: [number, number, number]; look: [number, number, number] } {
  const horizontal = Math.cos(o.pitch) * o.distance
  // Behind = opposite to where the camera looks.
  const eye: [number, number, number] = [
    p.x + Math.sin(o.yaw) * horizontal,
    focusHeight + Math.sin(o.pitch) * o.distance,
    p.z + Math.cos(o.yaw) * horizontal,
  ]
  return { eye, look: [p.x, focusHeight, p.z] }
}

/** A step of a spring toward `goal`: the same at any frame rate. */
export function follow(current: number, goal: number, dt: number, stiffness = 9): number {
  return current + (goal - current) * (1 - Math.exp(-stiffness * dt))
}
