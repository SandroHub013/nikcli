import { describe, expect, test } from "bun:test"
import { REACH, keyCommand, nearestPickable, pickWithRay, rayBox, raySphere, type Pickable, type Ray } from "./interaction"
import { COMPUTER_HEIGHT, SHOP_DEPTH, placementOf, shopBoxes, toWorld } from "./layout"

const computer = (paneId: string, x: number, z: number): Pickable => ({ paneId, x, y: COMPUTER_HEIGHT, z, radius: 0.6 })
const list = [computer("a", 0, 0), computer("b", 1, 1), computer("far", 10, 10)]

/** A ray from `from` at `to`. */
function through(from: [number, number, number], to: [number, number, number]): Ray {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
  const len = Math.hypot(d[0], d[1], d[2])
  return { ox: from[0], oy: from[1], oz: from[2], dx: d[0] / len, dy: d[1] / len, dz: d[2] / len }
}

describe("E next to a computer", () => {
  test("the nearest computer within 1.5 metres is the one that opens", () => {
    expect(keyCommand("KeyE", { x: 0.2, z: 0.1 }, list)).toEqual({ cmd: "open-session", paneId: "a" })
    expect(keyCommand("KeyE", { x: 1.2, z: 1.3 }, list)).toEqual({ cmd: "open-session", paneId: "b" })
    // Between two, the closer one.
    expect(keyCommand("KeyE", { x: 0.7, z: 0.7 }, list)).toEqual({ cmd: "open-session", paneId: "b" })
  })

  test("far from every computer, E does nothing", () => {
    expect(keyCommand("KeyE", { x: 5, z: 5 }, list)).toBeUndefined()
    expect(keyCommand("KeyE", { x: 0, z: REACH + 0.01 }, [computer("a", 0, 0)])).toBeUndefined()
    expect(keyCommand("KeyE", { x: 0, z: REACH }, [computer("a", 0, 0)])).toEqual({ cmd: "open-session", paneId: "a" })
    expect(keyCommand("KeyE", { x: 0, z: 0 }, [])).toBeUndefined()
  })

  test("only E does it, next to a computer or not", () => {
    for (const code of ["KeyW", "Space", "Enter", "KeyF", "Digit1", "KeyQ"])
      expect(keyCommand(code, { x: 0, z: 0 }, list)).toBeUndefined()
  })

  test("the nearest pickable is the answer, and a reach of zero finds only what it stands on", () => {
    expect(nearestPickable({ x: 0.9, z: 0.9 }, list)?.paneId).toBe("b")
    expect(nearestPickable({ x: 0, z: 0 }, list, 0)?.paneId).toBe("a")
    expect(nearestPickable({ x: 0.1, z: 0 }, list, 0)).toBeUndefined()
  })
})

describe("a click", () => {
  test("a ray through a computer picks it, one that misses picks nothing", () => {
    const hit = through([0, 5, 8], [0, COMPUTER_HEIGHT, 0])
    expect(raySphere(hit, list[0])).toBeGreaterThan(0)
    expect(pickWithRay(hit, list, [])?.paneId).toBe("a")
    const miss = through([0, 5, 8], [3, COMPUTER_HEIGHT, 0])
    expect(pickWithRay(miss, list, [])).toBeUndefined()
  })

  test("a computer behind the camera is not picked", () => {
    expect(pickWithRay(through([0, 5, 8], [0, 6, 20]), list, [])).toBeUndefined()
  })

  test("of two computers on the ray, the nearer one is picked", () => {
    const line = [computer("near", 0, 4), computer("behind", 0, 0)]
    expect(pickWithRay(through([0, COMPUTER_HEIGHT, 10], [0, COMPUTER_HEIGHT, 0]), line, [])?.paneId).toBe("near")
  })

  test("a wall in front of the computer stops the click; the same ray over the wall gets through", () => {
    const p = placementOf(0)
    const walls = shopBoxes(p, 0)
    const inside = toWorld(p, { x: 0, z: -2 })
    const target = { paneId: "in", x: inside.x, y: COMPUTER_HEIGHT, z: inside.z, radius: 0.6 }
    const back = toWorld(p, { x: 0, z: -SHOP_DEPTH / 2 - 6 })
    // Level with the computer, from behind the back wall: the wall is in the way.
    expect(pickWithRay(through([back.x, COMPUTER_HEIGHT, back.z], [target.x, target.y, target.z]), [target], walls)).toBeUndefined()
    // The same spot, from high above, coming down over the wall onto the computer.
    expect(pickWithRay(through([back.x, 14, back.z], [target.x, target.y, target.z]), [target], walls)?.paneId).toBe("in")
    // From the door side, through the gap: clear.
    const door = toWorld(p, { x: 0, z: SHOP_DEPTH / 2 + 5 })
    expect(pickWithRay(through([door.x, COMPUTER_HEIGHT, door.z], [target.x, target.y, target.z]), [target], walls)?.paneId).toBe("in")
  })

  test("a ray meets a wall box from the ground up to its height, and not above it", () => {
    const wall = { cx: 0, cz: 0, hx: 3, hz: 0.2, yaw: 0, height: 3.2 }
    expect(rayBox(through([0, 1, 10], [0, 1, 0]), wall)).toBeCloseTo(9.8, 9)
    expect(rayBox(through([0, 5, 10], [0, 5, 0]), wall)).toBeUndefined()
    expect(rayBox(through([9, 1, 10], [9, 1, 0]), wall)).toBeUndefined()
  })
})
