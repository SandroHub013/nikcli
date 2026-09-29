import { describe, expect, test } from "bun:test"
import { SHOP_DEPTH, SHOP_WIDTH, placementOf, toLocal } from "./layout"
import { SHOTS, SHOT_COUNT, SHOT_PEOPLE, SHOT_SHOPS, shotOf, shotPicture } from "./shots"
import { stageShot } from "./shot-handle"
import { createTown } from "./town"

const insideShop = (slot: number, p: [number, number, number]) => {
  const l = toLocal(placementOf(slot), { x: p[0], z: p[2] })
  return Math.abs(l.x) < SHOP_WIDTH / 2 && Math.abs(l.z) < SHOP_DEPTH / 2
}

describe("the bench's scene", () => {
  test("six shops and eighteen people, the same every time", () => {
    const a = shotPicture()
    expect(a.shops.size).toBe(6)
    expect(a.agents.size).toBe(18)
    expect(SHOT_SHOPS).toBe(6)
    expect(SHOT_PEOPLE).toBe(18)
    expect(JSON.stringify([...shotPicture().agents])).toBe(JSON.stringify([...a.agents]))
    expect(JSON.stringify([...shotPicture().shops])).toBe(JSON.stringify([...a.shops]))
    expect(new Set([...a.shops.values()].map((s) => s.slot)).size).toBe(6)
    // Every agent works in a shop that is there.
    for (const agent of a.agents.values()) expect(a.shops.has(agent.shop)).toBe(true)
  })

  test("the states cover what puts somebody at a desk", () => {
    const states = new Set([...shotPicture().agents.values()].map((a) => a.state))
    for (const s of ["work", "perm", "ask", "err", "limit", "idle"]) expect(states.has(s as never)).toBe(true)
  })

  test("a smaller scene is the first shops of the same one, for the shop that comes up last", () => {
    const five = shotPicture(5)
    const six = shotPicture()
    expect(five.shops.size).toBe(5)
    for (const [id, shop] of five.shops) expect(six.shops.get(id)).toEqual(shop)
    expect([...five.agents.keys()]).toEqual([...six.agents.keys()].slice(0, five.agents.size))
  })

  test("the town seats the first three of every shop at desks, and the first of shop 0 types at desk 0", () => {
    const town = createTown()
    town.sync(shotPicture())
    for (const a of town.agents()) expect(a.seat.kind).toBe("desk")
    const first = town.agentsOf("shot-shop-0")[0]
    expect(first.agent.state).toBe("work")
    expect(first.seat).toEqual({ kind: "desk", desk: 0 })
  })
})

describe("the eight shots", () => {
  test("there are eight, numbered from 1, each with its own name and a real camera", () => {
    expect(SHOTS).toHaveLength(SHOT_COUNT)
    expect(SHOTS.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(new Set(SHOTS.map((s) => s.name)).size).toBe(8)
    for (const s of SHOTS) {
      expect([...s.eye, ...s.look].every(Number.isFinite)).toBe(true)
      expect(s.eye).not.toEqual(s.look)
      expect(s.fov).toBeGreaterThan(10)
      expect(s.luminance[0]).toBeLessThan(s.luminance[1])
    }
  })

  test("shotOf finds a shot by its number and nothing else", () => {
    expect(shotOf(4)?.name).toBe("desk")
    expect(shotOf(0)).toBeUndefined()
    expect(shotOf(9)).toBeUndefined()
    expect(shotOf(1.5)).toBeUndefined()
    expect(shotOf(Number.NaN)).toBeUndefined()
  })

  test("only the desk shot has its camera inside a shop, and it is inside the shop of the one who types", () => {
    const slots = [0, 2, 4, 6, 8, 10]
    for (const s of SHOTS) {
      const inside = slots.filter((slot) => insideShop(slot, s.eye))
      expect(inside).toEqual(s.name === "desk" ? [0] : [])
    }
  })

  test("the permission shot looks into shop 3, at the desk of the one who asks, from across the square", () => {
    const s = shotOf(5)!
    expect(insideShop(6, s.look)).toBe(true)
    const [ex, , ez] = s.eye
    expect(Math.hypot(ex - s.look[0], ez - s.look[2])).toBeGreaterThan(25)
  })

  test("the rise shot is of the sixth shop, and it is the shop that the picture leaves out at first", () => {
    const s = shotOf(8)!
    expect(s.rising).toBe(true)
    const c = placementOf(10).center
    expect(Math.hypot(s.look[0] - c.x, s.look[2] - c.z)).toBeLessThan(1.5)
    expect(shotPicture(5).shops.has("shot-shop-5")).toBe(false)
    expect(shotPicture().shops.get("shot-shop-5")?.slot).toBe(10)
  })
})

describe("the scene as it is staged for a shot", () => {
  test("every shop is up and every person seated, twelve seconds in", () => {
    const town = createTown()
    stageShot(town, 1)
    expect(town.shops().map((s) => s.lift)).toEqual([1, 1, 1, 1, 1, 1])
    expect(town.agents().every((a) => a.presence === 1 && a.blend === 1)).toBe(true)
    expect(town.animating).toBe(false)
  })

  test("in the rise shot the sixth shop is half way up and the other five stand", () => {
    const town = createTown()
    stageShot(town, 8)
    const lifts = town.shops().map((s) => Number(s.lift.toFixed(3)))
    expect(lifts).toEqual([1, 1, 1, 1, 1, 0.5])
    expect(town.animating).toBe(true)
  })
})
