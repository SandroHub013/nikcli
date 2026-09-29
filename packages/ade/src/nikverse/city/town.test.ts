import { describe, expect, test } from "bun:test"
import type { Agent, Shop } from "../protocol"
import { nearestPickable, pickWithRay } from "./interaction"
import { COMPUTER_HEIGHT, DESKS_PER_SHOP, deskLocal, placementOf, ringRadius, toWorld } from "./layout"
import { STATE_LOOK } from "./states"
import { POSE_BLEND_SECONDS, PRESENCE_SECONDS, RISE_SECONDS, createTown, liftEase, type Picture } from "./town"

const shop = (id: string, slot?: number): Shop => ({ id, name: id, slot })
const agent = (paneId: string, shopId: string, over: Partial<Agent> = {}): Agent => ({
  paneId,
  title: paneId,
  kind: "claude-code",
  shop: shopId,
  state: "work",
  since: 1,
  look: { body: 1, palette: 2 },
  ...over,
})
const picture = (shops: Shop[], agents: Agent[] = []): Picture => ({
  shops: new Map(shops.map((s) => [s.id, s])),
  agents: new Map(agents.map((a) => [a.paneId, a])),
})
const settle = (town: ReturnType<typeof createTown>, seconds = 3) => {
  for (let t = 0; t < seconds; t += 0.05) town.tick(0.05)
}

describe("a shop coming up and going down", () => {
  test("a new project's shop starts under the pavement and is up after 0.8 seconds", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0)]))
    const [s] = town.shops()
    expect(s.lift).toBe(0)
    expect(town.animating).toBe(true)
    town.tick(RISE_SECONDS / 2)
    expect(s.lift).toBeCloseTo(0.5, 9)
    town.tick(RISE_SECONDS / 2)
    expect(s.lift).toBe(1)
    town.tick(1)
    expect(town.animating).toBe(false)
  })

  test("the rise eases out, and going down is the same curve run backwards", () => {
    expect(liftEase(0)).toBe(0)
    expect(liftEase(1)).toBe(1)
    expect(liftEase(0.5)).toBeGreaterThan(0.5)
    expect(liftEase(-1)).toBe(0)
    expect(liftEase(7)).toBe(1)
    for (const t of [0.1, 0.3, 0.7]) expect(liftEase(t)).toBeLessThan(liftEase(t + 0.1))
  })

  test("a project that is closed goes down and is gone when it is down, with its people", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0), shop("b", 1)], [agent("p1", "a"), agent("p2", "b")]))
    settle(town)
    town.sync(picture([shop("a", 0)], [agent("p1", "a")]))
    const [b] = town.shops().filter((s) => s.id === "b")
    expect(b.closing).toBe(true)
    expect(town.shops()).toHaveLength(2)
    town.tick(RISE_SECONDS / 2)
    expect(b.lift).toBeCloseTo(0.5, 9)
    // Its people are still in it while it goes down.
    expect(town.agentsOf("b")).toHaveLength(1)
    town.tick(RISE_SECONDS / 2 + 0.01)
    expect(town.shops().map((s) => s.id)).toEqual(["a"])
    expect(town.agentsOf("b")).toEqual([])
    expect(town.agents().map((a) => a.paneId)).toEqual(["p1"])
  })

  test("a project reopened while its shop is going down brings it back up from where it was", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0)]))
    settle(town)
    town.sync(picture([]))
    town.tick(0.4)
    const [s] = town.shops()
    const at = s.lift
    expect(at).toBeCloseTo(0.5, 9)
    town.sync(picture([shop("a", 0)]))
    expect(s.closing).toBe(false)
    expect(s.lift).toBe(at)
    town.tick(0.2)
    expect(s.lift).toBeGreaterThan(at)
    settle(town)
    expect(town.shops()).toHaveLength(1)
    expect(s.lift).toBe(1)
  })

  test("nothing moves at rest, so the city can draw nothing", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0)], [agent("p", "a")]))
    settle(town)
    expect(town.animating).toBe(false)
    town.sync(picture([shop("a", 0)], [agent("p", "a")]))
    expect(town.animating).toBe(false)
  })
})

describe("where the shops stand", () => {
  test("a shop stays in its slot while it exists, whatever is opened or closed around it", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0), shop("b", 1), shop("c", 2)]))
    settle(town)
    const slots = () => Object.fromEntries(town.shops().map((s) => [s.id, s.slot]))
    expect(slots()).toEqual({ a: 0, b: 1, c: 2 })
    town.sync(picture([shop("a", 0), shop("b", 1), shop("c", 2), shop("d")]))
    expect(slots()).toEqual({ a: 0, b: 1, c: 2, d: 3 })
    town.sync(picture([shop("a"), shop("c"), shop("d")]))
    settle(town)
    expect(slots()).toEqual({ a: 0, c: 2, d: 3 })
    town.sync(picture([shop("a"), shop("c"), shop("d"), shop("e")]))
    expect(town.shops().find((s) => s.id === "e")?.slot).toBe(1)
  })

  test("a shop's placement is its slot's: the door toward the square", () => {
    const town = createTown()
    town.sync(picture([shop("a", 4)]))
    expect(town.shops()[0].placement).toEqual(placementOf(4))
  })

  test("the walkable radius grows with the rings in use", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0)]))
    const small = town.radius()
    town.sync(picture([shop("a", 0), shop("b", 12)]))
    expect(town.radius()).toBeGreaterThan(small)
    expect(town.radius()).toBeGreaterThan(ringRadius(1))
  })
})

describe("who sits where", () => {
  test("each session gets the lowest free desk, and keeps it while others come and go", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0)], [agent("p1", "a"), agent("p2", "a"), agent("p3", "a")]))
    const desk = (id: string) => town.agents().find((a) => a.paneId === id)?.seat
    expect([desk("p1"), desk("p2"), desk("p3")]).toEqual([
      { kind: "desk", desk: 0 },
      { kind: "desk", desk: 1 },
      { kind: "desk", desk: 2 },
    ])
    settle(town)
    town.sync(picture([shop("a", 0)], [agent("p1", "a"), agent("p3", "a")]))
    settle(town)
    expect(desk("p3")).toEqual({ kind: "desk", desk: 2 })
    town.sync(picture([shop("a", 0)], [agent("p1", "a"), agent("p3", "a"), agent("p4", "a")]))
    expect(desk("p4")).toEqual({ kind: "desk", desk: 1 })
  })

  test("beyond the shop's desks the rest stand, each in a place of their own", () => {
    const town = createTown()
    const many = Array.from({ length: 11 }, (_, i) => agent(`p${i}`, "a"))
    town.sync(picture([shop("a", 0)], many))
    const seats = town.agents().map((a) => a.seat)
    expect(seats.filter((s) => s.kind === "desk")).toHaveLength(DESKS_PER_SHOP)
    expect(seats.filter((s) => s.kind === "stand").map((s) => (s as { index: number }).index)).toEqual(Array.from({ length: 11 - DESKS_PER_SHOP }, (_, i) => i))
  })

  test("a shop draws as many desks as it needs, at least two, at most eight", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0), shop("b", 1)], [agent("p1", "b"), agent("p2", "b"), agent("p3", "b"), agent("p4", "b")]))
    expect(town.deskCount("a")).toBe(2)
    expect(town.deskCount("b")).toBe(4)
    town.sync(picture([shop("b", 1)], Array.from({ length: 20 }, (_, i) => agent(`q${i}`, "b"))))
    expect(town.deskCount("b")).toBe(DESKS_PER_SHOP)
  })

  test("a session that goes leaves over 0.4 seconds, and is removed; a session of an unknown shop is ignored", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0)], [agent("p1", "a")]))
    settle(town)
    town.sync(picture([shop("a", 0)], [agent("stray", "nowhere")]))
    const [p] = town.agents()
    expect(p.leaving).toBe(true)
    town.tick(PRESENCE_SECONDS / 2)
    expect(p.presence).toBeCloseTo(0.5, 9)
    town.tick(PRESENCE_SECONDS)
    expect(town.agents()).toEqual([])
    expect(town.agents().map((a) => a.paneId)).not.toContain("stray")
  })

  test("a session spot is its chair, in the shop's frame, facing the back wall", () => {
    const town = createTown()
    town.sync(picture([shop("a", 3)], [agent("p1", "a")]))
    const a = town.agents()[0]
    const spot = town.spot(a)
    const p = placementOf(3)
    expect(spot?.onDesk).toBe(true)
    expect(spot?.at).toEqual(toWorld(p, deskLocal(0).chair))
    expect(spot?.yaw).toBeCloseTo(p.yaw + Math.PI, 9)
  })
})

describe("a session's state", () => {
  test("the state is passed on as ADE has it, and a change is blended in over a quarter of a second", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0)], [agent("p", "a", { state: "work" })]))
    const a = town.agents()[0]
    expect(a.look).toBe(STATE_LOOK.work)
    town.sync(picture([shop("a", 0)], [agent("p", "a", { state: "perm" })]))
    expect(a.look).toBe(STATE_LOOK.perm)
    expect(a.previous).toBe(STATE_LOOK.work)
    expect(a.blend).toBe(0)
    town.tick(POSE_BLEND_SECONDS / 2)
    expect(a.blend).toBeCloseTo(0.5, 9)
    town.tick(1)
    expect(a.blend).toBe(1)
  })

  test("the same state again changes nothing, and a state the world does not know is idle", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0)], [agent("p", "a", { state: "work" })]))
    settle(town)
    const a = town.agents()[0]
    town.sync(picture([shop("a", 0)], [agent("p", "a", { state: "work", since: 99 })]))
    expect(a.blend).toBe(1)
    expect(a.agent.since).toBe(99)
    town.sync(picture([shop("a", 0)], [agent("p", "a", { state: "levitating" as never })]))
    expect(a.look).toBe(STATE_LOOK.idle)
  })
})

describe("what can be clicked and what is in the way", () => {
  const built = () => {
    const town = createTown()
    town.sync(picture([shop("a", 0), shop("b", 1)], [agent("p1", "a"), agent("p2", "a"), agent("q1", "b")]))
    settle(town)
    return town
  }

  test("each seated session offers its computer, where the desk's computer is in the world", () => {
    const town = built()
    const found = town.pickables()
    expect(found.map((p) => p.paneId).sort()).toEqual(["p1", "p2", "q1"])
    const p1 = found.find((p) => p.paneId === "p1")!
    const at = toWorld(placementOf(0), deskLocal(0).computer)
    expect([p1.x, p1.z, p1.y]).toEqual([at.x, at.z, COMPUTER_HEIGHT])
  })

  test("nothing can be opened in a shop that is still coming up, or going down, or from a person who is leaving", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0)], [agent("p1", "a")]))
    town.tick(0.3)
    expect(town.pickables()).toEqual([])
    settle(town)
    expect(town.pickables()).toHaveLength(1)
    town.sync(picture([shop("a", 0)], []))
    expect(town.pickables()).toEqual([])
    settle(town)
    town.sync(picture([]))
    expect(town.pickables()).toEqual([])
  })

  test("standing next to a session's computer is what E needs; two shops apart is not", () => {
    const town = built()
    const at = toWorld(placementOf(0), deskLocal(1).computer)
    const near = nearestPickable({ x: at.x + 0.6, z: at.z + 0.6 }, town.pickables())
    expect(near?.paneId).toBe("p2")
    expect(nearestPickable({ x: 0, z: 0 }, town.pickables())).toBeUndefined()
  })

  test("the walls block the click on a computer from outside, and the ground boxes hold the shops' walls and desks", () => {
    const town = built()
    const target = town.pickables().find((p) => p.paneId === "p1")!
    const p = placementOf(0)
    const behind = toWorld(p, { x: 0, z: -12 })
    const dir = { x: target.x - behind.x, y: 0, z: target.z - behind.z }
    const len = Math.hypot(dir.x, dir.z)
    const ray = { ox: behind.x, oy: COMPUTER_HEIGHT, oz: behind.z, dx: dir.x / len, dy: 0, dz: dir.z / len }
    expect(pickWithRay(ray, town.pickables(), town.walls())).toBeUndefined()
    // 2 shops x 5 walls, plus the desks each draws (2 and 2 in a; 2 in b).
    expect(town.walls()).toHaveLength(10)
    expect(town.boxes().length).toBe(10 + town.deskCount("a") + town.deskCount("b"))
  })

  test("a shop that is not up yet has no walls to bump into", () => {
    const town = createTown()
    town.sync(picture([shop("a", 0)]))
    expect(town.boxes()).toEqual([])
    town.tick(RISE_SECONDS * 0.4)
    expect(town.boxes().length).toBeGreaterThan(0)
  })
})
