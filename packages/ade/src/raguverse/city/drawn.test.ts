import { describe, expect, test } from "bun:test"
import { BoxGeometry, Group, InstancedMesh, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene } from "three/webgpu"
import { DRAWN_CEILINGS, drawnOver, drawnPart, drawnSplit, type DrawnSplit } from "./drawn"

const material = new MeshBasicMaterial()
const box = () => new Mesh(new BoxGeometry(), material)
const named = <T extends { name: string }>(o: T, name: string) => Object.assign(o, { name })

describe("what a frame draws, part by part", () => {
  test("each mesh is in its part: the island's by name, the rest by the group it hangs from", () => {
    const shop = named(new Group(), "shop:a")
    const people = named(new Group(), "people")
    const person = box()
    const counter = box()
    shop.add(people, counter)
    people.add(named(new Group(), "person").add(person))
    expect(drawnPart(named(box(), "veg_lod0_leaves"))).toBe("veg_lod0")
    expect(drawnPart(named(box(), "veg_lod1_cola"))).toBe("veg_lod1")
    expect(drawnPart(named(box(), "veg_lod0_cola_far"))).toBe("veg_lod1")
    expect(drawnPart(named(box(), "veg_palm_tree"))).toBe("palms")
    expect(drawnPart(named(box(), "island_terrain"))).toBe("terrain")
    expect(drawnPart(named(box(), "island_water"))).toBe("water")
    expect(drawnPart(named(box(), "island_sky"))).toBe("sky")
    expect(drawnPart(person)).toBe("people")
    expect(drawnPart(counter)).toBe("shops")
    expect(drawnPart(named(box(), "plaza_base"))).toBe("rest")
  })

  test("it counts the triangles times the instances of what is in view and shown, one call a mesh", () => {
    const scene = new Scene()
    const camera = new PerspectiveCamera(60, 1, 0.1, 100)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    const plants = named(new InstancedMesh(new BoxGeometry(), material, 5), "veg_lod0_leaves")
    plants.computeBoundingSphere()
    const behind = named(box(), "island_terrain")
    behind.position.set(0, 0, 40)
    const hidden = named(box(), "island_water")
    hidden.visible = false
    scene.add(plants, behind, hidden)
    const split = drawnSplit(scene, camera)
    expect(split.veg_lod0).toEqual({ triangles: 12 * 5, calls: 1 })
    expect(split.terrain).toEqual({ triangles: 0, calls: 0 })
    expect(split.water).toEqual({ triangles: 0, calls: 0 })
  })

  test("a frame over the plan's ceilings says which, the plants counted with the palms", () => {
    const split = (plants: number) =>
      ({ veg_lod0: { triangles: plants / 2, calls: 8 }, veg_lod1: { triangles: plants / 2, calls: 8 }, palms: { triangles: 0, calls: 0 } }) as unknown as DrawnSplit
    expect(drawnOver({ triangles: 500_000, calls: 120 }, split(150_000))).toEqual([])
    expect(drawnOver({ triangles: DRAWN_CEILINGS.triangles + 1, calls: 151 }, split(DRAWN_CEILINGS.vegetation + 2))).toHaveLength(3)
  })
})
