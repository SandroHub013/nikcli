import { describe, expect, test } from "bun:test"
import { blocked } from "./collision"
import {
  BACK_BAR,
  COUNTER,
  DESKS_PER_SHOP,
  DESK_HALF,
  EAVE_HEIGHT,
  LOUNGERS,
  LOUNGER_HALF,
  MOUTH,
  PLATFORM_TOP,
  PLAZA_RADIUS,
  RING_SLOTS,
  SHOP_DEPTH,
  POSTS,
  POTS,
  POST_HALF,
  ROOF_TOP,
  SHOP_WIDTH,
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

  test("the beach's shore is not a circle: it comes and goes a metre or two, and never reaches the chiringuiti", () => {
    const waterline = (a: number) => {
      for (let r = 12; r < 30; r += 0.02) if (islandHeight({ x: Math.sin(a) * r, z: -Math.cos(a) * r }) > WATER_Y) return r
      return Infinity
    }
    // Round the circle, but off the pier (straight ahead), whose deck stands over the water.
    const radii = Array.from({ length: 72 }, (_, k) => (k / 72) * Math.PI * 2)
      .filter((a) => Math.cos(a) < 0.99)
      .map(waterline)
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(2)
    for (const r of radii) {
      expect(r).toBeGreaterThan(15.5)
      expect(r).toBeLessThan(21.5)
    }
    // Every slot of the first ring stands on flat sand, corner to corner.
    for (let slot = 0; slot < 12; slot++) {
      const p = placementOf(slot)
      const level = islandHeight(p.center)
      for (const x of [-SHOP_WIDTH / 2, SHOP_WIDTH / 2])
        for (const z of [-SHOP_DEPTH / 2, SHOP_DEPTH / 2]) expect([slot, islandHeight(toWorld(p, { x, z })) - level]).toEqual([slot, 0])
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

describe("inside a chiringuito", () => {
  const roof = { x: SHOP_WIDTH / 2, z: SHOP_DEPTH / 2 }
  const fixed = wallsLocal().length

  test("what stops the character is the back bar, the counter, the four posts and the three loungers; the front is open", () => {
    const walls = wallsLocal()
    expect(walls[0]).toEqual(BACK_BAR)
    expect(walls[1]).toEqual(COUNTER)
    expect(walls).toHaveLength(2 + POSTS.length + LOUNGERS.length + POTS.length)
    // The counter faces the hologram: it is in front of the back bar, with room behind it for whoever stands there.
    expect(COUNTER.z - COUNTER.hz - (BACK_BAR.z + BACK_BAR.hz)).toBeGreaterThan(1.5)
    // Round each end of the counter a body gets behind it, between the counter and the front posts.
    const frontPost = POSTS.find((p) => p.z > 0 && p.x > 0)!
    expect(frontPost.x - POST_HALF - (COUNTER.x + COUNTER.hx)).toBeGreaterThan(0.6)
    // The loungers are in front, toward the water, and nothing of the chiringuito is past them.
    for (const l of LOUNGERS) expect(l.z - LOUNGER_HALF.hz).toBeGreaterThan(roof.z)
    expect(EAVE_HEIGHT).toBeLessThan(ROOF_TOP)
  })

  test("the four seats: two stools at the counter and two small tables in front, with the laptop on each and nothing in the way", () => {
    const boxes = shopBoxes(placementOf(0), DESKS_PER_SHOP)
    const tables = boxes.slice(fixed)
    // The counter's seats are the counter; the tables are boxes of their own.
    expect(tables).toHaveLength(2)
    for (let i = 0; i < DESKS_PER_SHOP; i++) {
      const at = deskLocal(i)
      if (i < 2) {
        expect(at.desk.z).toBe(COUNTER.z)
        expect(Math.abs(at.desk.x) + DESK_HALF.hx).toBeLessThanOrEqual(COUNTER.hx)
      } else expect(at.desk.z - DESK_HALF.hz).toBeGreaterThan(COUNTER.z + COUNTER.hz + 0.5)
      // Each sits on the hologram's side of their table, facing the back bar; the laptop is past the table's middle.
      expect(at.chair.z).toBeGreaterThan(at.desk.z)
      expect(at.computer.z).toBeLessThan(at.desk.z)
      expect(at.computer.z).toBeGreaterThan(at.desk.z - DESK_HALF.hz)
      // A chair is clear of everything that stops the character, by a seated body.
      const chair = toWorld(placementOf(0), at.chair)
      const world = { boxes: boxes.filter((_, k) => k !== fixed + i - 2 || i < 2), radius: 200 }
      expect([i, blocked(chair, 0.15, world)]).toEqual([i, false])
      expect(Math.abs(at.chair.x)).toBeLessThan(roof.x)
    }
    for (let i = 0; i < tables.length; i++) for (let j = i + 1; j < tables.length; j++) expect(overlap(tables[i], tables[j])).toBe(false)
  })

  test("people standing (no seat left) stand behind the counter, in front of the back bar, in ten places of their own", () => {
    for (let i = 0; i < 12; i++) {
      const at = standLocal(i)
      expect(Math.abs(at.x)).toBeLessThan(COUNTER.hx)
      expect(at.z).toBeLessThan(COUNTER.z - COUNTER.hz - 0.2)
      expect(at.z).toBeGreaterThan(BACK_BAR.z + BACK_BAR.hz + 0.2)
    }
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
