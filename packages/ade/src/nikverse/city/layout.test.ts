import { describe, expect, test } from "bun:test"
import {
  DESKS_PER_SHOP,
  DESK_HALF,
  DOOR_WIDTH,
  MOUTH,
  PLATFORM_TOP,
  PLAZA_RADIUS,
  RING_SLOTS,
  SHOP_DEPTH,
  SHOP_WIDTH,
  WALL_THICKNESS,
  WATER_Y,
  deskLocal,
  islandHeight,
  placeShops,
  placementOf,
  ringRadius,
  shopBoxes,
  slotCenter,
  standLocal,
  toLocal,
  toWorld,
  wallsLocal,
  worldRadius,
  type Box,
} from "./layout"

const SLOTS = Array.from({ length: RING_SLOTS * 3 }, (_, i) => i)

/** Separating-axis test on the ground: whether two oriented boxes overlap. */
function overlap(a: Box, b: Box): boolean {
  const axes = [a.yaw, a.yaw + Math.PI / 2, b.yaw, b.yaw + Math.PI / 2].map((yaw) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) }))
  const corners = (box: Box) => {
    const s = Math.sin(box.yaw)
    const c = Math.cos(box.yaw)
    return [
      [-box.hx, -box.hz],
      [box.hx, -box.hz],
      [box.hx, box.hz],
      [-box.hx, box.hz],
    ].map(([x, z]) => ({ x: box.cx + x * c + z * s, z: box.cz - x * s + z * c }))
  }
  const ca = corners(a)
  const cb = corners(b)
  for (const axis of axes) {
    const project = (points: { x: number; z: number }[]) => {
      const values = points.map((p) => p.x * axis.x + p.z * axis.z)
      return [Math.min(...values), Math.max(...values)]
    }
    const [a0, a1] = project(ca)
    const [b0, b1] = project(cb)
    if (a1 < b0 || b1 < a0) return false
  }
  return true
}

describe("the ring of shops", () => {
  test("slot 0 is 13° to the right of straight ahead and slot 1 13° to the left, then 26° further each pair, twelve to a ring", () => {
    const deg = (slot: number) => (slotCenter(slot).angle * 180) / Math.PI
    expect(deg(0)).toBeCloseTo(13, 9)
    expect(deg(1)).toBeCloseTo(-13, 9)
    expect(deg(2)).toBeCloseTo(39, 9)
    expect(deg(3)).toBeCloseTo(-39, 9)
    expect(deg(10)).toBeCloseTo(143, 9)
    expect(deg(11)).toBeCloseTo(-143, 9)
    // Clockwise from above, from the first look (-z): a positive angle is to the right.
    expect(slotCenter(0).x).toBeGreaterThan(0)
    expect(slotCenter(0).z).toBeLessThan(0)
    expect(Math.hypot(slotCenter(0).x, slotCenter(0).z)).toBeCloseTo(ringRadius(0), 9)
    // The next ring starts again at the front, further out.
    expect(Math.hypot(slotCenter(12).x, slotCenter(12).z)).toBeCloseTo(ringRadius(1), 9)
    expect(slotCenter(12).angle).toBeCloseTo(slotCenter(0).angle, 9)
    expect(ringRadius(1)).toBeGreaterThan(ringRadius(0))
  })

  test("no slot's centre is in the lagoon's mouth, and neighbours are the same distance apart", () => {
    for (let slot = 0; slot < 24; slot++) {
      const fromSouth = Math.PI - Math.abs(slotCenter(slot).angle)
      expect([slot, fromSouth >= MOUTH.halfAngle - 1e-9]).toEqual([slot, true])
    }
    const gap = (a: number, b: number) => Math.hypot(slotCenter(a).x - slotCenter(b).x, slotCenter(a).z - slotCenter(b).z)
    expect(gap(0, 1)).toBeCloseTo(gap(0, 2), 9)
    expect(gap(0, 1)).toBeGreaterThan(SHOP_WIDTH + 6)
  })

  test("the island's ground: the deck under the hologram, the lagoon's floor under the water, the beach above it", () => {
    expect(islandHeight({ x: 0, z: 0 })).toBe(PLATFORM_TOP)
    expect(islandHeight({ x: 0, z: 13 })).toBe(0)
    expect(islandHeight({ x: 0, z: 13 })).toBeLessThan(WATER_Y)
    const beach = placementOf(0).center
    expect(islandHeight(beach)).toBeGreaterThan(WATER_Y)
    // A chiringuito stands on flat sand, from its back wall to its bar.
    for (const z of [-SHOP_DEPTH / 2, 0, SHOP_DEPTH / 2]) expect(islandHeight(toWorld(placementOf(0), { x: 0, z }))).toBeCloseTo(islandHeight(beach), 9)
    // The ground never jumps more than the deck's step.
    for (let r = 0; r < 40; r += 0.05) {
      const step = Math.abs(islandHeight({ x: 0, z: r + 0.05 }) - islandHeight({ x: 0, z: r }))
      expect(step).toBeLessThanOrEqual(PLATFORM_TOP - 0.1)
    }
  })

  test("every shop's door faces the square: the door is nearer to the centre than the back wall", () => {
    for (const slot of SLOTS) {
      const p = placementOf(slot)
      const door = toWorld(p, { x: 0, z: SHOP_DEPTH / 2 })
      const back = toWorld(p, { x: 0, z: -SHOP_DEPTH / 2 })
      expect([slot, Math.hypot(door.x, door.z) < Math.hypot(back.x, back.z)]).toEqual([slot, true])
      // And local +z points at the origin.
      const ahead = toWorld(p, { x: 0, z: 1 })
      const toOrigin = { x: -p.center.x, z: -p.center.z }
      const len = Math.hypot(toOrigin.x, toOrigin.z)
      expect(ahead.x - p.center.x).toBeCloseTo(toOrigin.x / len, 9)
      expect(ahead.z - p.center.z).toBeCloseTo(toOrigin.z / len, 9)
    }
  })

  test("the shop's frame and the world round-trip", () => {
    for (const slot of [0, 1, 5, 14, 30]) {
      const p = placementOf(slot)
      for (const local of [
        { x: 0, z: 0 },
        { x: 3.2, z: -2.1 },
        { x: -5, z: 4 },
      ]) {
        const back = toLocal(p, toWorld(p, local))
        expect(back.x).toBeCloseTo(local.x, 9)
        expect(back.z).toBeCloseTo(local.z, 9)
      }
    }
  })

  test("no shop touches another, in any ring, nor the square", () => {
    const boxes = SLOTS.map((slot) => shopBoxes(placementOf(slot), DESKS_PER_SHOP))
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        for (const a of boxes[i]) for (const b of boxes[j]) expect([i, j, overlap(a, b)]).toEqual([i, j, false])
      }
      for (const box of boxes[i]) {
        const nearest = Math.hypot(box.cx, box.cz) - Math.hypot(box.hx, box.hz)
        expect(nearest).toBeGreaterThan(PLAZA_RADIUS)
      }
    }
  })
})

describe("inside a shop", () => {
  const interior = { x: SHOP_WIDTH / 2 - WALL_THICKNESS, z: SHOP_DEPTH / 2 - WALL_THICKNESS }

  test("the walls are the back, both sides and the front with a gap exactly as wide as the door", () => {
    const walls = wallsLocal()
    expect(walls).toHaveLength(5)
    const front = walls.filter((w) => w.z === SHOP_DEPTH / 2)
    expect(front).toHaveLength(2)
    const [left, right] = front.sort((a, b) => a.x - b.x)
    const gap = right.x - right.hx - (left.x + left.hx)
    expect(gap).toBeCloseTo(DOOR_WIDTH, 9)
    expect(left.x + right.x).toBeCloseTo(0, 9)
  })

  test("every desk, chair and monitor stands inside the walls, and no two desks touch", () => {
    const desks = shopBoxes(placementOf(0), DESKS_PER_SHOP).slice(5)
    expect(desks).toHaveLength(DESKS_PER_SHOP)
    for (let i = 0; i < DESKS_PER_SHOP; i++) {
      const at = deskLocal(i)
      for (const spot of [at.desk, at.computer]) {
        expect(Math.abs(spot.x)).toBeLessThan(interior.x)
        expect(Math.abs(spot.z)).toBeLessThan(interior.z)
      }
      expect(Math.abs(at.desk.x) + DESK_HALF.hx).toBeLessThan(interior.x)
      // The person sits on the door's side of the desk, facing the back wall; the monitor stands on the desk's far edge (the keyboard
      // has the near one), so it is past the desk's middle from the chair.
      expect(at.chair.z).toBeGreaterThan(at.desk.z)
      expect(at.computer.z).toBeLessThan(at.desk.z)
      expect(at.computer.z).toBeGreaterThan(at.desk.z - DESK_HALF.hz)
      // N3's front row sits in the window: a chair past the wall's line is in the gap of the door, not in the wall.
      if (Math.abs(at.chair.z) >= interior.z) expect(Math.abs(at.chair.x) + 0.25).toBeLessThan(DOOR_WIDTH / 2)
      else expect(Math.abs(at.chair.x)).toBeLessThan(interior.x)
      for (let j = i + 1; j < DESKS_PER_SHOP; j++) expect([i, j, overlap(desks[i], desks[j])]).toEqual([i, j, false])
    }
  })

  test("people standing (no desk left) stand inside, behind the desks, in ten places of their own", () => {
    const desks = shopBoxes(placementOf(0), DESKS_PER_SHOP).slice(5)
    const local = Array.from({ length: DESKS_PER_SHOP }, (_, i) => deskLocal(i).desk)
    for (let i = 0; i < 12; i++) {
      const at = standLocal(i)
      expect(Math.abs(at.x)).toBeLessThan(interior.x)
      expect(at.z).toBeLessThan(interior.z)
      expect(at.z).toBeGreaterThan(-interior.z)
      // Behind every desk, along the back wall, clear of them by more than a body.
      for (const d of local) expect(at.z).toBeLessThan(d.z - DESK_HALF.hz - 0.25)
    }
    expect(desks).toHaveLength(DESKS_PER_SHOP)
    // Two rows of five; past ten they share a place, which is a crowd and not a place.
    expect(new Set(Array.from({ length: 10 }, (_, i) => `${standLocal(i).x}:${standLocal(i).z}`)).size).toBe(10)
    expect(standLocal(10)).toEqual(standLocal(0))
  })
})

describe("slots stay put", () => {
  const shops = (ids: string[], slots: Array<number | undefined> = []) => ids.map((id, i) => ({ id, slot: slots[i] }))
  const kept = (m: Map<string, number>) => new Map(m)

  test("ADE's slots are honoured", () => {
    const placed = placeShops(shops(["a", "b", "c"], [4, 0, 9]), new Map())
    expect([...placed]).toEqual(expect.arrayContaining([["a", 4], ["b", 0], ["c", 9]]))
  })

  test("a new project never moves the others", () => {
    const first = placeShops(shops(["a", "b"], [0, 1]), new Map())
    const second = placeShops(shops(["a", "b", "c"], [undefined, undefined, undefined]), kept(first))
    expect(second.get("a")).toBe(0)
    expect(second.get("b")).toBe(1)
    expect(second.get("c")).toBe(2)
    // Even when ADE now asks for the slot that a placed shop holds.
    const third = placeShops(shops(["a", "b", "c", "d"], [0, 1, 2, 1]), kept(second))
    expect([third.get("a"), third.get("b"), third.get("c")]).toEqual([0, 1, 2])
    expect(third.get("d")).toBe(3)
  })

  test("a shop that goes leaves its slot free for the next, and the rest stay", () => {
    const first = placeShops(shops(["a", "b", "c"], [0, 1, 2]), new Map())
    const after = placeShops(shops(["a", "c", "d"]), kept(first))
    expect([after.get("a"), after.get("c")]).toEqual([0, 2])
    expect(after.get("d")).toBe(1)
  })

  test("two shops claiming one slot get different ones, and a missing or bad slot gets the lowest free", () => {
    const placed = placeShops(shops(["a", "b", "c", "d"], [3, 3, undefined, -1]), new Map())
    expect(new Set(placed.values()).size).toBe(4)
    expect(placed.get("a")).toBe(3)
    expect([...placed.values()].every((n) => Number.isInteger(n) && n >= 0)).toBe(true)
    expect([placed.get("b"), placed.get("c"), placed.get("d")].sort()).toEqual([0, 1, 2])
  })

  test("it is the same for the same pictures, whatever order the shops arrive in", () => {
    const one = placeShops(shops(["x", "y", "z"]), new Map())
    const two = placeShops(shops(["z", "x", "y"]), new Map())
    expect([...one].sort()).toEqual([...two].sort())
  })

  test("the ground reaches past the last ring in use", () => {
    expect(worldRadius([])).toBeGreaterThan(ringRadius(0))
    expect(worldRadius([0, 11])).toBe(worldRadius([5]))
    expect(worldRadius([12])).toBeGreaterThan(worldRadius([11]))
  })
})
