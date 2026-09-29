import { describe, expect, test } from "bun:test"
import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, Vector3 } from "three/webgpu"
import type { Agent, Shop } from "../protocol"
import { spawnPlayer } from "./controller"
import { COMPUTER_HEIGHT, WALL_HEIGHT, placementOf } from "./layout"
import { GLOW_COLOR } from "./states"
import { RISE_SECONDS, createTown, type Picture, type Town } from "./town"
import { createCityScene } from "./view"

const shop = (id: string, slot?: number, name = id): Shop => ({ id, name, slot })
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

/** The camera stands a few metres in front of a shop's door, looking at it: near enough for the whole figure. */
const camera = new PerspectiveCamera(58, 1.6, 0.1, 400)
function stand(slot = 0) {
  const p = placementOf(slot)
  camera.position.set(p.center.x, 4, p.center.z).addScaledVector(new Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw)), 12)
  camera.lookAt(p.center.x, 1, p.center.z)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
}
stand()

function build(pic: Picture, seconds = 3) {
  const town = createTown()
  const view = createCityScene()
  town.sync(pic)
  for (let t = 0; t < seconds; t += 0.05) town.tick(0.05)
  view.update(town, spawnPlayer(), 1, camera)
  view.scene.updateMatrixWorld(true)
  return { town, view }
}

const world = (o: { getWorldPosition(v: Vector3): Vector3 }) => o.getWorldPosition(new Vector3())

describe("the city drawn from the town", () => {
  test("a group per shop and a person per session, and no more", () => {
    const { view } = build(picture([shop("a", 0), shop("b", 1)], [agent("p1", "a"), agent("p2", "a"), agent("q1", "b")]))
    expect(view.counts()).toEqual({ shops: 2, people: 3 })
  })

  test("a person stands at their chair, in the world, facing the back wall of their shop", () => {
    const { town, view } = build(picture([shop("a", 3)], [agent("p1", "a"), agent("p2", "a")]))
    for (const a of town.agents()) {
      const person = view.person(a.paneId)!
      const spot = town.spot(a)!
      const at = world(person.group)
      expect([at.x, at.z].map((n) => Math.round(n * 1e6))).toEqual([spot.at.x, spot.at.z].map((n) => Math.round(n * 1e6)))
      // Their +z (the way they face) points where the chair faces.
      const facing = new Vector3(0, 0, 1).applyQuaternion(person.group.getWorldQuaternion(new Quaternion()))
      expect(facing.x).toBeCloseTo(Math.sin(spot.yaw), 6)
      expect(facing.z).toBeCloseTo(Math.cos(spot.yaw), 6)
    }
  })

  test("the computer that is drawn is the one that can be clicked: the same place", () => {
    const { town, view } = build(picture([shop("a", 5), shop("b", 8)], [agent("p1", "a"), agent("p2", "a"), agent("q1", "b")]))
    for (const target of town.pickables()) {
      const monitor = view.monitor(target.paneId)
      expect(monitor).toBeDefined()
      const at = world(monitor!)
      expect(at.x).toBeCloseTo(target.x, 1)
      expect(at.z).toBeCloseTo(target.z, 1)
      expect(at.y).toBeCloseTo(COMPUTER_HEIGHT, 6)
    }
  })

  test("a shop stands on the ground when it is up, and is under it while it comes up or goes down", () => {
    const town = createTown()
    const view = createCityScene()
    town.sync(picture([shop("a", 2)]))
    view.update(town, spawnPlayer(), 0, camera)
    const group = view.scene.getObjectByName("shop:a") as Group
    const sunk = group.position.y
    expect(sunk).toBeLessThan(-WALL_HEIGHT)
    town.tick(RISE_SECONDS * 0.5)
    view.update(town, spawnPlayer(), 0, camera)
    expect(group.position.y).toBeGreaterThan(sunk)
    expect(group.position.y).toBeLessThan(0)
    town.tick(RISE_SECONDS)
    view.update(town, spawnPlayer(), 0, camera)
    expect(group.position.y + 0).toBe(0)
    const p = placementOf(2)
    expect([group.position.x, group.position.z]).toEqual([p.center.x, p.center.z])
    expect(group.rotation.y).toBe(p.yaw)
  })

  test("a session that is away leaves an empty chair and a dark screen", () => {
    const { town, view } = build(picture([shop("a", 0)], [agent("p1", "a"), agent("p2", "a", { state: "off" })]))
    expect(view.person("p1")!.group.visible).toBe(true)
    expect(view.person("p2")!.group.visible).toBe(false)
    expect((view.monitor("p2")!.material as MeshBasicMaterial).color.getHex()).toBe(GLOW_COLOR.off)
    expect((view.monitor("p1")!.material as MeshBasicMaterial).color.getHex()).toBe(GLOW_COLOR.cool)
    expect(town.agents()).toHaveLength(2)
  })

  test("the state shows on the screen and over the head: a permission is amber with a mark, an error red without", () => {
    const { view } = build(
      picture([shop("a", 0)], [agent("p1", "a", { state: "perm" }), agent("p2", "a", { state: "err" }), agent("p3", "a", { state: "ask" })]),
    )
    const glow = (id: string) => (view.monitor(id)!.material as MeshBasicMaterial).color.getHex()
    expect([glow("p1"), glow("p2"), glow("p3")]).toEqual([GLOW_COLOR.amber, GLOW_COLOR.red, GLOW_COLOR.blue])
    const mark = (id: string) => {
      const p = view.person(id)!
      return [p.signal.visible, p.attention.visible, p.question.visible]
    }
    expect(mark("p1")).toEqual([true, true, false])
    expect(mark("p2")).toEqual([false, false, false])
    expect(mark("p3")).toEqual([true, false, true])
  })

  test("a new state changes the pose within the blend, and the pose is the state's", () => {
    const town = createTown()
    const view = createCityScene()
    town.sync(picture([shop("a", 0)], [agent("p", "a", { state: "idle" })]))
    for (let t = 0; t < 2; t += 0.05) town.tick(0.05)
    view.update(town, spawnPlayer(), 0, camera)
    const person = view.person("p")!
    const before = person.armR.rotation.x
    town.sync(picture([shop("a", 0)], [agent("p", "a", { state: "perm" })]))
    for (let t = 0; t < 0.5; t += 0.05) town.tick(0.05)
    view.update(town, spawnPlayer(), 0.5, camera)
    // The raised hand is up over the head: more than a quarter turn beyond the resting arm.
    expect(person.armR.rotation.x).toBeLessThan(before - 1.5)
  })

  test("a shop that closes is taken out of the scene when it is down, and what it made is disposed", () => {
    const disposed: unknown[] = []
    const original = MeshBasicMaterial.prototype.dispose
    MeshBasicMaterial.prototype.dispose = function () {
      disposed.push(this)
      return original.call(this)
    }
    try {
      const town = createTown()
      const view = createCityScene()
      town.sync(picture([shop("a", 0), shop("b", 1)], [agent("p", "b")]))
      for (let t = 0; t < 3; t += 0.05) town.tick(0.05)
      view.update(town, spawnPlayer(), 0, camera)
      expect(view.counts().shops).toBe(2)
      town.sync(picture([shop("a", 0)]))
      for (let t = 0; t < RISE_SECONDS + 0.1; t += 0.05) town.tick(0.05)
      const before = disposed.length
      view.update(town, spawnPlayer(), 0, camera)
      expect(view.counts()).toEqual({ shops: 1, people: 0 })
      expect(view.scene.getObjectByName("shop:b")).toBeUndefined()
      // The sign and the monitors of that shop: at least its two desks' screens and its sign.
      expect(disposed.length - before).toBeGreaterThanOrEqual(3)
    } finally {
      MeshBasicMaterial.prototype.dispose = original
    }
  })

  test("a renamed project gets a new shop group with the new name, not a second shop", () => {
    const town = createTown()
    const view = createCityScene()
    town.sync(picture([shop("a", 0, "old")]))
    view.update(town, spawnPlayer(), 0, camera)
    const first = view.scene.getObjectByName("shop:a")
    town.sync(picture([shop("a", 0, "new")]))
    view.update(town, spawnPlayer(), 0, camera)
    expect(view.counts().shops).toBe(1)
    expect(view.scene.getObjectByName("shop:a")).not.toBe(first)
    expect(view.scene.children.filter((c) => c.name === "shop:a")).toHaveLength(1)
  })

  test("the user's character is where the player is, facing where it goes, and walks with its legs", () => {
    const town = createTown()
    const view = createCityScene()
    view.update(town, { x: 3, z: -4, heading: 1.2, speed: 0, vx: 0, vz: 0 }, 5, camera)
    expect([view.user.group.position.x, view.user.group.position.z, view.user.group.rotation.y]).toEqual([3, -4, 1.2])
    expect(view.user.legL.rotation.x).toBe(0)
    view.update(town, { x: 3, z: -4, heading: 1.2, speed: 3.2, vx: 0, vz: 0 }, 5.15, camera)
    expect(Math.abs(view.user.legL.rotation.x)).toBeGreaterThan(0.05)
    expect(view.user.legL.rotation.x).toBe(-view.user.legR.rotation.x)
  })

  test("the square is there before any project is: the hologram and the projector in the middle of an empty city", () => {
    const { view } = build(picture([]))
    expect(view.counts()).toEqual({ shops: 0, people: 0 })
    expect(view.scene.getObjectByName("hologram")).toBeDefined()
    expect(view.scene.getObjectByName("logo-voxels")).toBeDefined()
  })

  test("the reference city (8 shops, 24 people) stays a small scene: a regression guard for the quality piece", () => {
    const shops = Array.from({ length: 8 }, (_, i) => shop(`s${i}`, i))
    const agents = shops.flatMap((s, i) => Array.from({ length: 3 }, (_, k) => agent(`${s.id}-${k}`, s.id, { look: { body: i, palette: k } })))
    const { view } = build(picture(shops, agents))
    let meshes = 0
    let triangles = 0
    view.scene.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh || !m.visible) return
      meshes++
      const g = m.geometry
      const count = (g.index ? g.index.count : g.attributes.position.count) / 3
      const instances = (m as unknown as { isInstancedMesh?: boolean; count: number }).isInstancedMesh
        ? (m as unknown as { count: number }).count
        : 1
      triangles += count * instances
    })
    expect(view.counts()).toEqual({ shops: 8, people: 24 })
    expect(meshes).toBeLessThan(2800)
    expect(triangles).toBeLessThan(200_000)
  })
})

describe("what is drawn depends on where the camera is", () => {
  /** A camera high over the square, looking at a shop's centre from this many metres out along its door. */
  const camAt = (slot: number, out: number, height = 4) => {
    const p = placementOf(slot)
    const c = new PerspectiveCamera(58, 1.6, 0.1, 400)
    c.position.set(p.center.x + Math.sin(p.yaw) * out, height, p.center.z + Math.cos(p.yaw) * out)
    c.lookAt(p.center.x, 1, p.center.z)
    c.updateProjectionMatrix()
    c.updateMatrixWorld(true)
    return c
  }
  const one = () => {
    const town = createTown()
    const view = createCityScene()
    town.sync(picture([shop("a", 0)], [agent("p1", "a"), agent("p2", "a", { state: "perm" })]))
    for (let t = 0; t < 3; t += 0.05) town.tick(0.05)
    return { town, view }
  }

  test("near, the whole figure with its mark; past 30 metres one box, and no mark", () => {
    const { town, view } = one()
    view.update(town, spawnPlayer(), 1, camAt(0, 12))
    expect([view.person("p1")!.body.visible, view.person("p1")!.impostor.visible]).toEqual([true, false])
    expect(view.person("p2")!.signal.visible).toBe(true)
    view.update(town, spawnPlayer(), 2, camAt(0, 60))
    expect([view.person("p1")!.body.visible, view.person("p1")!.impostor.visible]).toEqual([false, true])
    expect(view.person("p2")!.signal.visible).toBe(false)
  })

  test("past 15 metres the pose is worked out ten times a second, near it every frame, and an impostor's never", () => {
    const { town, view } = one()
    const posed = () => view.person("p1")!.posedAt
    const near = camAt(0, 8)
    view.update(town, spawnPlayer(), 10, near)
    view.update(town, spawnPlayer(), 10.02, near)
    expect(posed()).toBe(10.02)
    const middle = camAt(0, 26)
    view.update(town, spawnPlayer(), 20, middle)
    expect(posed()).toBe(20)
    view.update(town, spawnPlayer(), 20.04, middle)
    expect(posed()).toBe(20)
    view.update(town, spawnPlayer(), 20.11, middle)
    expect(posed()).toBe(20.11)
    const far = camAt(0, 60)
    view.update(town, spawnPlayer(), 30, far)
    view.update(town, spawnPlayer(), 31, far)
    expect(posed()).toBe(20.11)
  })

  test("a shop the camera is not looking at, or is far from, is not drawn, and its people are not posed", () => {
    const { town, view } = one()
    const group = () => view.scene.getObjectByName("shop:a")!
    view.update(town, spawnPlayer(), 1, camAt(0, 12))
    expect(group().visible).toBe(true)
    const posed = view.person("p1")!.posedAt
    // Turned the other way round.
    const away = camAt(0, 12)
    away.rotateY(Math.PI)
    away.updateMatrixWorld(true)
    view.update(town, spawnPlayer(), 2, away)
    expect(group().visible).toBe(false)
    expect(view.person("p1")!.posedAt).toBe(posed)
    // Looking at it, but from far past the range.
    view.update(town, spawnPlayer(), 3, camAt(0, 300, 30))
    expect(group().visible).toBe(false)
    view.update(town, spawnPlayer(), 4, camAt(0, 12))
    expect(group().visible).toBe(true)
  })

  test("everyone has a blob shadow on the floor, and nothing in the scene casts a real one", () => {
    const { town, view } = one()
    view.update(town, spawnPlayer(), 1, camAt(0, 12))
    for (const person of [view.person("p1")!, view.person("p2")!, view.user]) {
      expect(person.blob.parent).toBe(person.group)
      expect(person.blob.position.y).toBeGreaterThan(0)
      expect(person.blob.position.y).toBeLessThan(0.1)
      expect((person.blob.material as MeshBasicMaterial).transparent).toBe(true)
    }
    const casters: string[] = []
    view.scene.traverse((o) => {
      if ((o as Mesh).castShadow || (o as Mesh).receiveShadow) casters.push(o.type)
    })
    expect(casters).toEqual([])
  })

  test("the hologram is dressed for the renderer: node materials for WebGPU, shaders for the classic one", () => {
    const kinds = (kind: "tsl" | "shader") => {
      const seen = new Set<string>()
      createCityScene(undefined, kind)
        .scene.getObjectByName("logo-voxels")!
        .traverse((o) => {
          const m = (o as Mesh).material as { isNodeMaterial?: boolean; isShaderMaterial?: boolean } | undefined
          if (m) seen.add(m.isNodeMaterial ? "node" : m.isShaderMaterial ? "shader" : "other")
        })
      return [...seen]
    }
    expect(kinds("tsl")).toEqual(["node"])
    expect(kinds("shader")).toEqual(["shader"])
  })
})

export type { Town }
