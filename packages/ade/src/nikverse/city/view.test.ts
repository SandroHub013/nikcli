import { describe, expect, test } from "bun:test"
import { Box3, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, type ShaderMaterial, Vector3 } from "three/webgpu"
import type { Agent, Shop } from "../protocol"
import { SIGNAL_MAX_SCALE } from "./characters"
import { spawnPlayer } from "./controller"
import { CHAIR_SEAT_TOP, COMPUTER_HEIGHT, DESKS_PER_SHOP, PLATFORM_TOP, SHOP_DEPTH, WALL_HEIGHT, WALL_THICKNESS, placementOf } from "./layout"
import { castOf, kitFor } from "./test-cast"
import { GLOW_COLOR } from "./states"
import { RISE_SECONDS, createTown, type Picture, type Town } from "./town"
import { SHOP_RADIUS, createCityScene } from "./view"

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

  test("near, the whole figure with its mark; past 30 metres one box, and the mark still there", () => {
    const { town, view } = one()
    view.update(town, spawnPlayer(), 1, camAt(0, 12))
    expect([view.person("p1")!.body.visible, view.person("p1")!.impostor.visible]).toEqual([true, false])
    expect(view.person("p2")!.signal.visible).toBe(true)
    view.update(town, spawnPlayer(), 2, camAt(0, 60))
    expect([view.person("p1")!.body.visible, view.person("p1")!.impostor.visible]).toEqual([false, true])
    expect(view.person("p2")!.signal.visible).toBe(true)
    expect(view.person("p2")!.attention.visible).toBe(true)
    // And the session that does not need the user has none, near or far.
    expect(view.person("p1")!.signal.visible).toBe(false)
  })

  test("a session that starts to need the user while it is far shows the mark, without its figure being posed; it goes when the need does", () => {
    const { town, view } = one()
    const far = camAt(0, 80)
    view.update(town, spawnPlayer(), 1, far)
    expect(view.person("p1")!.signal.visible).toBe(false)
    town.sync(picture([shop("a", 0)], [agent("p1", "a", { state: "ask" }), agent("p2", "a", { state: "work" })]))
    for (let t = 0; t < 2; t += 0.05) town.tick(0.05)
    view.update(town, spawnPlayer(), 2, far)
    expect([view.person("p1")!.signal.visible, view.person("p1")!.question.visible, view.person("p1")!.attention.visible]).toEqual([true, true, false])
    expect(view.person("p2")!.signal.visible).toBe(false)
    // An impostor is never posed: the mark is the only thing that changed.
    expect(view.person("p1")!.posedAt).toBe(-1)
    // Back near, it is the same mark; and once the session is answered it goes, near or far.
    view.update(town, spawnPlayer(), 3, camAt(0, 8))
    expect(view.person("p1")!.signal.visible).toBe(true)
    town.sync(picture([shop("a", 0)], [agent("p1", "a"), agent("p2", "a")]))
    for (let t = 0; t < 2; t += 0.05) town.tick(0.05)
    view.update(town, spawnPlayer(), 4, far)
    expect(view.person("p1")!.signal.visible).toBe(false)
  })

  test("the mark grows with the distance, from 25 metres, up to five times, and stays above the head", () => {
    const { town, view } = one()
    const scaleAt = (out: number) => {
      view.update(town, spawnPlayer(), 1, camAt(0, out))
      return view.person("p2")!.signal.scale.x
    }
    // The distance is the camera's to the person, who sits a couple of metres inside the shop.
    expect(scaleAt(8)).toBe(1)
    expect(scaleAt(20)).toBe(1)
    expect(scaleAt(60)).toBeGreaterThan(2)
    expect(scaleAt(60)).toBeLessThan(3)
    expect(scaleAt(130)).toBe(SIGNAL_MAX_SCALE)
    expect(view.person("p2")!.signal.position.y).toBeGreaterThan(1.95 + 0.25 * (SIGNAL_MAX_SCALE - 1) - 0.06)
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

  // Every light in the scene is evaluated by every pixel of every material: in the bench a close-up interior spends 3 to 4 ms of
  // its 11 on the sun alone. The ceiling is the diet's (A1); A2's baked light is meant to take the number down, not up.
  test("the scene has at most four lights that are worked out at every pixel, with or without N3's kit, and none of them a point or a spot", async () => {
    const lights = (scene: { traverse(fn: (o: { type: string; isLight?: boolean }) => void): void }) => {
      const seen: string[] = []
      scene.traverse((o) => {
        if (o.isLight) seen.push(o.type)
      })
      return seen
    }
    const plain = lights(createCityScene().scene)
    const kit = await kitFor("bassa")
    const withKit = lights(createCityScene(undefined, "tsl", undefined, kit).scene)
    for (const seen of [plain, withKit]) {
      expect(seen.length).toBeLessThanOrEqual(4)
      expect(seen.filter((t) => t === "PointLight" || t === "SpotLight")).toEqual([])
    }
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

describe("the city with N3's people", () => {
  const camAt = (out: number, height = 4) => {
    const p = placementOf(0)
    const c = new PerspectiveCamera(58, 1.6, 0.1, 400)
    c.position.set(p.center.x + Math.sin(p.yaw) * out, height, p.center.z + Math.cos(p.yaw) * out)
    c.lookAt(p.center.x, 1, p.center.z)
    c.updateProjectionMatrix()
    c.updateMatrixWorld(true)
    return c
  }
  const rigged = async (agents: Agent[]) => {
    const town = createTown()
    const view = createCityScene(undefined, "shader", await castOf("bassa"))
    town.sync(picture([shop("a", 0)], agents))
    for (let t = 0; t < 3; t += 0.05) town.tick(0.05)
    return { town, view }
  }
  const roleOf = (view: ReturnType<typeof createCityScene>, id: string) => view.person(id)!.rig!.role

  test("a session is one of three bodies by its look, the user is the mage, and all of them are rigged", async () => {
    const { town, view } = await rigged([
      agent("p1", "a", { look: { body: 0, palette: 0 } }),
      agent("p2", "a", { look: { body: 1, palette: 0 } }),
      agent("p3", "a", { look: { body: 2, palette: 0 } }),
    ])
    view.update(town, spawnPlayer(), 1, camAt(6))
    const names = (id: string) => {
      const found: string[] = []
      view.person(id)!.rig!.root.traverse((o) => {
        if (/_lod0$/.test(o.name)) found.push(o.name)
      })
      return found
    }
    expect([names("p1"), names("p2"), names("p3")]).toEqual([["agent_knight_lod0"], ["agent_rogue_lod0"], ["agent_barbarian_lod0"]])
    const user: string[] = []
    view.user.rig!.root.traverse((o) => {
      if (/_lod0$/.test(o.name)) user.push(o.name)
    })
    expect(user).toEqual(["user_lod0"])
  })

  test("the state picks the clip: typing, the raised hand, sitting, and nothing for who is away", async () => {
    const { town, view } = await rigged([agent("p1", "a"), agent("p2", "a", { state: "perm" }), agent("p3", "a", { state: "idle" }), agent("p4", "a", { state: "err" })])
    view.update(town, spawnPlayer(), 1, camAt(6))
    expect([roleOf(view, "p1"), roleOf(view, "p2"), roleOf(view, "p3"), roleOf(view, "p4")]).toEqual(["type", "raise_hand", "sit", "error"])
    town.sync(picture([shop("a", 0)], [agent("p1", "a", { state: "off" }), agent("p2", "a", { state: "ask" })]))
    for (let t = 0; t < 2; t += 0.05) town.tick(0.05)
    view.update(town, spawnPlayer(), 2, camAt(6))
    expect(roleOf(view, "p2")).toBe("turn")
    expect(view.person("p1")!.group.visible).toBe(false)
  })

  test("a seated person is raised until the pelvis is on the seat; somebody with no desk stands and is not lowered", async () => {
    const crowd = Array.from({ length: DESKS_PER_SHOP + 1 }, (_, i) => agent(`p${i}`, "a"))
    const { town, view } = await rigged(crowd)
    view.update(town, spawnPlayer(), 1, camAt(6))
    const seated = view.person("p0")!
    expect(seated.body.position.y).toBeCloseTo(CHAIR_SEAT_TOP - seated.rig!.seatY, 6)
    const standing = view.person(`p${DESKS_PER_SHOP}`)!
    expect(standing.body.position.y).toBe(0)
    expect(standing.rig!.role).toBe("idle")
  })

  test("the seat a person is raised to is the top of the chair drawn at the desk", async () => {
    const { town, view } = await rigged([agent("p0", "a")])
    view.update(town, spawnPlayer(), 1, camAt(6))
    view.scene.updateMatrixWorld(true)
    const chair = view.scene
      .getObjectByName("shop:a")!
      .children.flatMap((c) => c.children)
      .find((o) => (o as Mesh).isMesh && Math.abs(o.scale.y - 0.06) < 1e-6 && Math.abs(o.scale.x - 0.5) < 1e-6) as Mesh
    // 0.5 m is the chair as N3 has it (a 6 cm seat drawn under its top); the number is in the test so that moving one moves both on purpose.
    expect(chair.position.y + chair.scale.y / 2).toBeCloseTo(0.5, 6)
    expect(CHAIR_SEAT_TOP).toBeCloseTo(0.5, 6)
  })

  test("near the whole body and its hat, farther a lighter one, the farthest without the hat, and past 30 metres the box", async () => {
    const { town, view } = await rigged([agent("p1", "a", { look: { body: 2, palette: 0 } })])
    const shown = () => {
      const person = view.person("p1")!
      return [person.body.visible, ...person.rig!.lods.map((m) => m.visible), person.rig!.accessories.some((a) => a.visible)]
    }
    view.update(town, spawnPlayer(), 1, camAt(3))
    expect(shown()).toEqual([true, true, false, false, true])
    view.update(town, spawnPlayer(), 2, camAt(12))
    expect(shown()).toEqual([true, false, true, false, true])
    view.update(town, spawnPlayer(), 3, camAt(22))
    expect(shown()).toEqual([true, false, false, true, false])
    view.update(town, spawnPlayer(), 4, camAt(60))
    expect(view.person("p1")!.body.visible).toBe(false)
    expect(view.person("p1")!.impostor.visible).toBe(true)
  })

  test("the far ones' clips are stepped ten times a second, the near ones' every frame, and an impostor's never", async () => {
    const { town, view } = await rigged([agent("p1", "a")])
    const clock = () => view.person("p1")!.rig!.at
    const near = camAt(4)
    view.update(town, spawnPlayer(), 10, near)
    view.update(town, spawnPlayer(), 10.02, near)
    expect(clock()).toBe(10.02)
    const middle = camAt(20)
    view.update(town, spawnPlayer(), 20, middle)
    view.update(town, spawnPlayer(), 20.04, middle)
    expect(clock()).toBe(20)
    view.update(town, spawnPlayer(), 20.11, middle)
    expect(clock()).toBe(20.11)
    view.update(town, spawnPlayer(), 40, camAt(60))
    expect(clock()).toBe(20.11)
  })

  test("the user stands, walks and runs by the pace, and the clip is played at the pace of the ground covered", async () => {
    const { town, view } = await rigged([])
    const camera = camAt(6)
    view.update(town, { ...spawnPlayer(), speed: 0 }, 1, camera)
    expect(view.user.rig!.role).toBe("idle")
    view.update(town, { ...spawnPlayer(), speed: 3.2 }, 1.1, camera)
    expect(view.user.rig!.role).toBe("walk")
    expect(view.user.rig!.actions.get("walk")!.getEffectiveTimeScale()).toBeGreaterThan(1)
    view.update(town, { ...spawnPlayer(), speed: 6.4 }, 1.2, camera)
    expect(view.user.rig!.role).toBe("run")
  })

  test("without the cast the city is the placeholders, and nothing about them changed", () => {
    const view = createCityScene()
    expect(view.user.rig).toBeUndefined()
  })
})

describe("the island from the file, with its chiringuiti", () => {
  const withKit = async (agents: Agent[], shops = [shop("a", 0)]) => {
    const town = createTown()
    const kit = await kitFor("bassa")
    const view = createCityScene(undefined, "shader", await castOf("bassa"), kit)
    town.sync(picture(shops, agents))
    for (let t = 0; t < 3; t += 0.05) town.tick(0.05)
    view.update(town, spawnPlayer(), 1, camera)
    view.scene.updateMatrixWorld(true)
    return { town, view, kit }
  }
  const names = (root: { traverse(fn: (o: { name: string }) => void): void }) => {
    const found: string[] = []
    root.traverse((o) => found.push(o.name))
    return found
  }

  test("the island is the file's, and the placeholders' square, edge and lamps are not there", async () => {
    const { view, kit } = await withKit([])
    expect(kit.island).toBe(true)
    expect(view.scene.children).toContain(kit.plaza)
    const all = names(view.scene)
    for (const name of ["island_terrain", "island_deck", "island_pier", "island_water", "island_sky", "plaza_kerb", "plaza_base"]) expect(all).toContain(name)
    expect(view.scene.children.filter((o) => (o as unknown as { isInstancedMesh?: boolean }).isInstancedMesh)).toHaveLength(0)
  })

  test("the lagoon and the sky are painted for the renderer, one material each, the sky out of the fog", async () => {
    const { view } = await withKit([])
    const water = view.scene.getObjectByName("island_water") as Mesh
    const sky = view.scene.getObjectByName("island_sky") as Mesh
    expect((water.material as ShaderMaterial).isShaderMaterial).toBe(true)
    expect((sky.material as ShaderMaterial).isShaderMaterial).toBe(true)
    expect((water.material as ShaderMaterial).fog).toBe(true)
    expect((sky.material as ShaderMaterial).fog).toBe(false)
    // The water knows how deep it is: its vertex colours.
    expect(water.geometry.hasAttribute("color")).toBe(true)
  })

  test("a shop is N3's pieces, not boxes: floor, shell, window, awning, desks, chairs, screens", async () => {
    const { view } = await withKit([agent("p1", "a")])
    const all = names(view.scene.getObjectByName("shop:a")!)
    for (const name of ["floor", "shell", "glass", "trim", "desk", "chair", "props"]) expect(all.some((n) => new RegExp(`^shop\\d*_${name}$`).test(n))).toBe(true)
  })

  test("the shop's desks are all there, and what is added over them is the glow of the desks in use", async () => {
    const { view } = await withKit([agent("p1", "a", { state: "perm" }), agent("p2", "a")])
    const glows = view.scene.getObjectByName("shop:a")!.children.flatMap((c) => c.children).filter((o) => (o as Mesh).isMesh && (o as Mesh).geometry.type === "PlaneGeometry")
    // Two desks in use: two glow planes, at the layout's computers, in front of the monitors' faces.
    expect(glows.length).toBeGreaterThanOrEqual(2)
    const monitor = view.monitor("p1")!
    expect(monitor.position.y).toBeCloseTo(COMPUTER_HEIGHT, 6)
    expect((monitor.material as MeshBasicMaterial).color.getHex()).toBe(GLOW_COLOR.amber)
  })

  test("the sign's text is on the awning's board, at N3's height", async () => {
    const { view } = await withKit([])
    const sign = view.scene.getObjectByName("shop:a")!.children.find((o) => (o as Mesh).isMesh && (o as Mesh).geometry.type === "PlaneGeometry") as Mesh
    expect(sign.position.y).toBeCloseTo(3.02, 2)
    expect(sign.position.z).toBeGreaterThan(SHOP_DEPTH / 2 + WALL_THICKNESS / 2)
  })

  test("the hologram has no projector of its own and floats where the file's anchor says", async () => {
    const { view, kit } = await withKit([])
    // The projector is a closed cylinder; the cone of light is an open one and stays.
    const discs = (group: { children: Array<unknown> }) =>
      group.children.filter((c) => {
        const geometry = (c as Mesh).geometry as { type?: string; parameters?: { openEnded?: boolean } } | undefined
        return geometry?.type === "CylinderGeometry" && !geometry.parameters?.openEnded
      })
    expect(discs(view.hologram.group)).toHaveLength(0)
    expect(discs(createCityScene().hologram.group)).toHaveLength(1)
    // On the island it stands on the deck, and the anchor is measured from there.
    expect(view.hologram.group.position.y).toBeCloseTo(kit.ringY - 0.27 + PLATFORM_TOP, 6)
    // The placeholders' plaza keeps its projector.
    expect(createCityScene().hologram.group.position.y).toBe(0)
  })

  test("people sit on the seats of the shop's own chairs: the layout and the file agree on where they are", async () => {
    const { view } = await withKit([agent("p1", "a"), agent("p2", "a"), agent("p3", "a"), agent("p4", "a")])
    const chairs = (await kitFor("bassa")).shop().children.find((c) => /^shop\d*_chair$/.test(c.name)) as Mesh
    expect(chairs).toBeDefined()
    const top = new Box3().setFromObject(chairs)
    for (let i = 1; i <= 4; i++) {
      const person = view.person(`p${i}`)!
      // The pelvis is raised to the seat's height.
      expect(person.body.position.y + person.rig!.seatY).toBeCloseTo(CHAIR_SEAT_TOP, 6)
      expect(top.max.y).toBeGreaterThan(CHAIR_SEAT_TOP)
    }
  })

  test("the shop is drawn within its sphere for the culling: the sign and awning are inside it", async () => {
    const { view } = await withKit([])
    const box = new Box3().setFromObject(view.scene.getObjectByName("shop:a")!)
    const centre = placementOf(0).center
    const farthest = Math.max(...[box.min.x, box.max.x].flatMap((x) => [box.min.z, box.max.z].map((z) => Math.hypot(x - centre.x, z - centre.z))))
    expect(farthest).toBeLessThan(SHOP_RADIUS + 0.01)
  })
})

export type { Town }
