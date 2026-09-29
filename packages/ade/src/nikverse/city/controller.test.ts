import { describe, expect, test } from "bun:test"
import {
  BODY_RADIUS,
  MAX_DISTANCE,
  MAX_PITCH,
  MIN_DISTANCE,
  MIN_PITCH,
  NO_INPUT,
  RUN_SPEED,
  WALK_SPEED,
  cameraGoal,
  follow,
  inputKey,
  lookAround,
  spawnPlayer,
  startOrbit,
  stepPlayer,
  turnToward,
  wantedDirection,
  zoom,
  type Input,
} from "./controller"
import type { World } from "./collision"
import { SHOP_DEPTH, placementOf, shopBoxes, toLocal, toWorld } from "./layout"

const open: World = { boxes: [], radius: 500 }
const press = (over: Partial<Input>): Input => ({ ...NO_INPUT, ...over })

describe("the keys", () => {
  test("WASD and the arrows are by physical position, so they are the same on any layout; Shift runs", () => {
    expect(["KeyW", "KeyA", "KeyS", "KeyD"].map(inputKey)).toEqual(["forward", "left", "back", "right"])
    expect(["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].map(inputKey)).toEqual(["forward", "left", "back", "right"])
    expect(inputKey("ShiftLeft")).toBe("run")
    expect(inputKey("ShiftRight")).toBe("run")
  })

  test("E, the letters that are ADE's shortcuts, and everything else are not movement", () => {
    for (const code of ["KeyE", "KeyK", "KeyP", "Space", "Escape", "Tab", "Enter", "ControlLeft", "AltLeft", "MetaLeft"])
      expect([code, inputKey(code)]).toEqual([code, undefined])
  })
})

describe("moving relative to the camera", () => {
  const near = (a: { x: number; z: number }, x: number, z: number) => {
    expect(a.x).toBeCloseTo(x, 9)
    expect(a.z).toBeCloseTo(z, 9)
  }

  test("W goes where the camera looks, A and D to its left and right, S back", () => {
    near(wantedDirection(press({ forward: true }), 0), 0, -1)
    near(wantedDirection(press({ back: true }), 0), 0, 1)
    near(wantedDirection(press({ right: true }), 0), 1, 0)
    near(wantedDirection(press({ left: true }), 0), -1, 0)
  })

  test("turning the camera turns the keys with it", () => {
    // A camera turned a quarter to the left looks toward -x.
    near(wantedDirection(press({ forward: true }), Math.PI / 2), -1, 0)
    near(wantedDirection(press({ right: true }), Math.PI / 2), 0, -1)
    near(wantedDirection(press({ forward: true }), Math.PI), 0, 1)
  })

  test("diagonals are not faster, and opposite keys cancel", () => {
    for (const yaw of [0, 0.7, 2.1]) {
      const d = wantedDirection(press({ forward: true, right: true }), yaw)
      expect(Math.hypot(d.x, d.z)).toBeCloseTo(1, 9)
    }
    expect(wantedDirection(press({ forward: true, back: true }), 1)).toEqual({ x: 0, z: 0 })
    expect(wantedDirection(NO_INPUT, 1)).toEqual({ x: 0, z: 0 })
  })
})

describe("the character", () => {
  const run = (input: Input, seconds: number, yaw = 0, world = open, from = spawnPlayer({ x: 0, z: 0 })) => {
    let p = from
    for (let t = 0; t < seconds; t += 1 / 60) p = stepPlayer(p, input, yaw, 1 / 60, world)
    return p
  }

  test("it walks at walking speed and runs faster with Shift", () => {
    const walked = run(press({ forward: true }), 2)
    const ran = run(press({ forward: true, run: true }), 2)
    expect(walked.speed).toBeCloseTo(WALK_SPEED, 6)
    expect(ran.speed).toBeCloseTo(RUN_SPEED, 6)
    expect(-walked.z).toBeGreaterThan(WALK_SPEED * 1.6)
    expect(-ran.z).toBeGreaterThan(-walked.z * 1.6)
  })

  test("it stops quickly when the keys are let go, and does not drift", () => {
    const moving = run(press({ forward: true }), 1)
    const stopped = run(NO_INPUT, 0.5, 0, open, moving)
    expect(stopped.speed).toBe(0)
    const z = stopped.z
    expect(run(NO_INPUT, 1, 0, open, stopped).z).toBe(z)
  })

  test("it turns to face the way it goes, the short way round", () => {
    const p = run(press({ right: true }), 1)
    expect(p.heading).toBeCloseTo(Math.PI / 2, 2)
    expect(turnToward(0.1, Math.PI * 2 - 0.1, 5)).toBeCloseTo(-0.1, 9)
    expect(turnToward(0, Math.PI, 0.5)).toBeCloseTo(0.5, 9)
  })

  test("it does not go through a wall, however fast it is pushed at it", () => {
    const p = placementOf(0)
    const world = { boxes: shopBoxes(p, 2), radius: 500 }
    // From behind the shop, running in at the back wall, with the camera turned to look at it.
    const start = toWorld(p, { x: 0, z: -SHOP_DEPTH / 2 - 3 })
    const inward = { x: p.center.x - start.x, z: p.center.z - start.z }
    const yaw = Math.atan2(-inward.x, -inward.z)
    const end = run(press({ forward: true, run: true }), 6, yaw, world, spawnPlayer(start))
    const local = toLocal(p, end)
    expect(local.z).toBeLessThan(-SHOP_DEPTH / 2)
    expect(BODY_RADIUS).toBeGreaterThan(0)
  })
})

describe("the camera", () => {
  test("the mouse turns the camera: right turns right, down looks down and raises it", () => {
    const start = startOrbit()
    expect(lookAround(start, 100, 0).yaw).toBeLessThan(start.yaw)
    expect(lookAround(start, -100, 0).yaw).toBeGreaterThan(start.yaw)
    expect(lookAround(start, 0, 100).pitch).toBeGreaterThan(start.pitch)
    expect(lookAround(start, 0, 100, 0.0025, true).pitch).toBeLessThan(start.pitch)
  })

  test("it cannot look straight down or under the ground, and the zoom has limits", () => {
    let o = startOrbit()
    o = lookAround(o, 0, 1e6)
    expect(o.pitch).toBe(MAX_PITCH)
    o = lookAround(o, 0, -1e6)
    expect(o.pitch).toBe(MIN_PITCH)
    expect(zoom(startOrbit(), 1e6).distance).toBe(MAX_DISTANCE)
    expect(zoom(startOrbit(), -1e6).distance).toBe(MIN_DISTANCE)
  })

  test("it stands behind the character and above, looking at the shoulders", () => {
    const goal = cameraGoal({ x: 4, z: 6 }, { yaw: 0, pitch: 0.5, distance: 7 })
    expect(goal.look).toEqual([4, 1.4, 6])
    // Looking toward -z, so the camera is at greater z; and above the focus.
    expect(goal.eye[2]).toBeGreaterThan(6)
    expect(goal.eye[1]).toBeGreaterThan(1.4)
    expect(goal.eye[0]).toBeCloseTo(4, 9)
    expect(Math.hypot(goal.eye[0] - 4, goal.eye[1] - 1.4, goal.eye[2] - 6)).toBeCloseTo(7, 9)
    // Turned a quarter, it moves round with it.
    const turned = cameraGoal({ x: 0, z: 0 }, { yaw: Math.PI / 2, pitch: 0.5, distance: 7 })
    expect(turned.eye[0]).toBeGreaterThan(5)
    expect(turned.eye[2]).toBeCloseTo(0, 9)
  })

  test("the spring gets there and is the same at any frame rate", () => {
    let fast = 0
    for (let i = 0; i < 60; i++) fast = follow(fast, 10, 1 / 60)
    let slow = 0
    for (let i = 0; i < 6; i++) slow = follow(slow, 10, 1 / 6)
    expect(fast).toBeCloseTo(slow, 9)
    expect(fast).toBeGreaterThan(9.9)
    expect(follow(3, 3, 0.1)).toBe(3)
  })
})
