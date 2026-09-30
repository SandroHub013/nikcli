import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Matrix4, type BufferGeometry, type InstancedMesh, type Mesh, type MeshBasicMaterial, type Object3D } from "three/webgpu"
import { readGlb } from "./glb"
import { SHOP_TINTS, VEG_SECTORS, VEG_STRIDE, shopLook, vegSector } from "./kit"
import {
  BACK_BAR,
  CHAIR_SEAT_TOP,
  COMPUTER_HEIGHT,
  COUNTER,
  DESKS_PER_SHOP,
  DESK_HALF,
  DESK_HEIGHT,
  EAVE_HEIGHT,
  LOUNGERS,
  LOUNGER_HALF,
  MOUTH,
  PIER,
  PLATFORM_RADIUS,
  PLATFORM_TOP,
  POSTS,
  POST_HALF,
  WATER_Y,
  deskLocal,
  islandHeight,
  wallsLocal,
} from "./layout"
import { LEVELS_DIR, kitFor, presentLevels } from "./test-cast"

/**
 * The layout is numbers and the shops are meshes; these hold the two to each other, on the real `city.glb`: what
 * the code says is a wall, a desk, a chair or a monitor is where the file draws one, in every shop the file has.
 */

interface Part {
  min: [number, number, number]
  max: [number, number, number]
  center: [number, number, number]
}

/** The connected pieces of a mesh, each as a box: a merged mesh of four desks is four parts. */
function parts(geometry: BufferGeometry): Part[] {
  const pos = geometry.attributes.position
  const index = geometry.index
  const parent: number[] = []
  const ids = new Map<string, number>()
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }
  const idOf = (i: number) => {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`
    let id = ids.get(key)
    if (id === undefined) {
      id = parent.length
      parent.push(id)
      ids.set(key, id)
    }
    return id
  }
  const count = index ? index.count : pos.count
  for (let t = 0; t < count; t += 3) {
    const v = [0, 1, 2].map((o) => idOf(index ? index.getX(t + o) : t + o))
    for (const x of v) parent[find(x)] = find(v[0])
  }
  const boxes = new Map<number, number[]>()
  for (let i = 0; i < pos.count; i++) {
    const root = find(idOf(i))
    const b = boxes.get(root) ?? [1e9, 1e9, 1e9, -1e9, -1e9, -1e9]
    for (const [k, axis] of [[0, pos.getX(i)], [1, pos.getY(i)], [2, pos.getZ(i)]] as const) {
      b[k] = Math.min(b[k], axis)
      b[k + 3] = Math.max(b[k + 3], axis)
    }
    boxes.set(root, b)
  }
  return [...boxes.values()].map((b) => ({
    min: [b[0], b[1], b[2]],
    max: [b[3], b[4], b[5]],
    center: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2],
  }))
}

const meshNamed = (root: Object3D, name: string | RegExp): Mesh => {
  let found: Mesh | undefined
  root.traverse((o) => {
    if (!found && (typeof name === "string" ? o.name === name : name.test(o.name)) && (o as Mesh).isMesh) found = o as Mesh
  })
  if (!found) throw new Error(`no ${name} in the file`)
  return found
}

const near = (a: number, b: number, tolerance = 0.03) => Math.abs(a - b) <= tolerance

const cityGlb = (level: string) => readGlb(new Uint8Array(readFileSync(join(LEVELS_DIR, level, "city.glb"))))

describe.each(presentLevels())("the city at %s against the layout", (level) => {
  /** Every shop the file has, one after the other. */
  const shops = async () => {
    const kit = await kitFor(level)
    return Array.from({ length: kit.variants }, (_, v) => ({ v, shop: kit.shop(v) }))
  }
  const plaza = async () => (await kitFor(level)).plaza

  /** A chiringuito's mesh by what it is: `fixtures` is `chir_base_fixtures`, `counter` the counter it got. */
  const piece = (shop: Object3D, what: string) => meshNamed(shop, new RegExp(`^chir_[a-z]+\\d*_${what}$`))
  /** Whether a piece's footprint is the box's, within a few centimetres. */
  const covers = (p: Part, box: { x: number; z: number; hx: number; hz: number }, tolerance = 0.03) =>
    near(p.min[0], box.x - box.hx, tolerance) && near(p.max[0], box.x + box.hx, tolerance) && near(p.min[2], box.z - box.hz, tolerance) && near(p.max[2], box.z + box.hz, tolerance)

  test("the file has a chiringuito's parts, and every roof, counter and sign together is a shop", async () => {
    const glb = cityGlb(level)
    const kinds = (what: string) => new Set((glb.json.nodes ?? []).flatMap((n) => new RegExp(`^chir_${what}(\\d+)_`).exec(n.name ?? "")?.[1] ?? []))
    const [roofs, bars, signs] = [kinds("roof").size, kinds("bar").size, kinds("sign").size]
    expect(Math.min(roofs, bars, signs)).toBeGreaterThanOrEqual(3)
    expect((await kitFor(level)).variants).toBe(roofs * bars * signs)
  })

  test("what stops the character is what the file draws: the counter, the back bar, the posts and the loungers", async () => {
    for (const { v, shop } of await shops()) {
      const walls = wallsLocal()
      const fixtures = parts(piece(shop, "fixtures").geometry)
      // The counter is its own mesh, and what sticks out of its box (the rail, the logs) is less than a body's radius: nobody walks into it.
      const counter = piece(shop, "counter")
      counter.geometry.computeBoundingBox()
      const bounds = counter.geometry.boundingBox!
      expect([v, parts(counter.geometry).some((p) => covers(p, COUNTER))]).toEqual([v, true])
      expect([v, near(bounds.max.y, COUNTER.height)]).toEqual([v, true])
      expect([v, bounds.min.x >= COUNTER.x - COUNTER.hx - 0.15, bounds.max.x <= COUNTER.x + COUNTER.hx + 0.15]).toEqual([v, true, true])
      expect([v, bounds.min.z >= COUNTER.z - COUNTER.hz - 0.15, bounds.max.z <= COUNTER.z + COUNTER.hz + 0.15]).toEqual([v, true, true])
      // The back bar's cabinet, the posts as tall as the eaves, the loungers' frames.
      expect([v, fixtures.some((p) => covers(p, BACK_BAR))]).toEqual([v, true])
      for (const post of POSTS) {
        const found = fixtures.find((p) => covers(p, { ...post, hx: POST_HALF, hz: POST_HALF }, 0.02))
        expect([v, post, found !== undefined]).toEqual([v, post, true])
        expect(near(found!.max[1], EAVE_HEIGHT)).toBe(true)
      }
      for (const lounger of LOUNGERS) expect([v, lounger, fixtures.some((p) => covers(p, { ...lounger, ...LOUNGER_HALF }))]).toEqual([v, lounger, true])
      expect(walls).toHaveLength(2 + POSTS.length + LOUNGERS.length)
    }
  })

  test("the seats are the layout's: two at the counter, two small tables of its size and height, in its places", async () => {
    for (const { v, shop } of await shops()) {
      const fixtures = parts(piece(shop, "fixtures").geometry)
      expect(COUNTER.height).toBe(DESK_HEIGHT)
      for (let i = 0; i < DESKS_PER_SHOP; i++) {
        const at = deskLocal(i).desk
        // At the counter the counter is the table; in front the table is a top of its own.
        if (at.z === COUNTER.z) continue
        const top = fixtures.find((p) => covers(p, { ...at, ...DESK_HALF }) && p.max[1] - p.min[1] < 0.1)
        expect([v, i, top !== undefined]).toEqual([v, i, true])
        expect(near(top!.max[1], DESK_HEIGHT)).toBe(true)
      }
    }
  })

  test("the stools and chairs are where the people sit, with the seat at the height the pelvis is seated at", async () => {
    for (const { v, shop } of await shops()) {
      const seats = parts(piece(shop, "fixtures").geometry).filter((p) => near(p.max[1], CHAIR_SEAT_TOP, 0.02) && p.max[1] - p.min[1] < 0.1)
      for (let i = 0; i < DESKS_PER_SHOP; i++) {
        const at = deskLocal(i).chair
        expect([v, i, seats.some((p) => near(p.center[0], at.x) && near(p.center[2], at.z))]).toEqual([v, i, true])
      }
    }
  })

  test("the laptops are the layout's computers: the lid's middle at its height, just behind where the glow is drawn", async () => {
    for (const { v, shop } of await shops()) {
      const lids = parts(piece(shop, "fixtures").geometry).filter((p) => near(p.max[0] - p.min[0], 0.3, 0.025) && p.max[1] - p.min[1] > 0.15)
      for (let i = 0; i < DESKS_PER_SHOP; i++) {
        const at = deskLocal(i).computer
        const here = lids.filter((p) => near(p.center[0], at.x) && near(p.center[2], at.z))
        expect([v, i, here.length > 0]).toEqual([v, i, true])
        for (const lid of here) {
          expect(near(lid.center[1], COMPUTER_HEIGHT)).toBe(true)
          // The glow stands 2 cm in front of the middle, on the side the person sits: past the lid's front face.
          expect(lid.center[2]).toBeLessThan(at.z + 0.02)
        }
      }
    }
  })

  test("under every roof the sand is darker in its shadow and warmer in the pool of its lamps, and plain at the edges", async () => {
    const kit = await kitFor(level)
    for (let v = 0; v < kit.variants; v++) {
      const shop = kit.shop(v)
      const colours = (what: string) => {
        const mesh = piece(shop, what)
        const c = mesh.geometry.attributes.color
        const pos = mesh.geometry.attributes.position
        return Array.from({ length: c.count }, (_, i) => ({ x: pos.getX(i), z: pos.getZ(i), rgb: [c.getX(i), c.getY(i), c.getZ(i)] }))
      }
      const shade = colours("shade")
      const pool = colours("pool")
      // The shadow: under the roof the sand is at most two thirds of its light.
      expect([v, Math.min(...shade.map((p) => p.rgb[1])) < 0.67]).toEqual([v, true])
      // The pool: warm (more red than blue), strongest near the counter.
      const warmest = pool.reduce((a, b) => (b.rgb[0] > a.rgb[0] ? b : a))
      expect([v, warmest.rgb[0] > 0.15, warmest.rgb[0] > warmest.rgb[2] * 2]).toEqual([v, true, true])
      expect([v, Math.abs(warmest.x) < 3.2, Math.abs(warmest.z - COUNTER.z) < 2]).toEqual([v, true, true])
      // At the edge of the grid both are nothing: the chiringuito's sand melts into the island's.
      const edge = (p: { x: number; z: number }) => Math.abs(p.x) > 5.4
      expect([v, Math.max(...pool.filter(edge).map((p) => p.rgb[0])) < 0.01]).toEqual([v, true])
      expect([v, Math.min(...shade.filter(edge).map((p) => p.rgb[1])) > 0.99]).toEqual([v, true])
    }
  })

  test("the plants are instances of the file's prototypes, a slice of the circle each (the palms whole), all out of where one walks", async () => {
    const kit = await kitFor(level)
    const glb = cityGlb(level)
    const lists = new Map(
      (glb.json.nodes ?? []).flatMap((n) => {
        const list = (n.extras as { nkv_instances?: number[] } | undefined)?.nkv_instances
        return list ? [[n.name!.replace(/^veg_/, ""), list] as const] : []
      }),
    )
    expect([...lists.keys()].sort()).toEqual(["lod0", "lod1", "palm"])
    const planted = kit.plaza.children.filter((c) => (c as InstancedMesh).isInstancedMesh) as InstancedMesh[]
    // Two LODs of leaves and colas in their slices, and the palms: the plan's 16 draw calls, and one.
    expect(planted.length).toBeLessThanOrEqual(4 * VEG_SECTORS + 1)
    for (const [set, list] of lists) {
      expect(list.length % VEG_STRIDE).toBe(0)
      const pieces = new Set(planted.filter((m) => m.name.startsWith(`veg_${set}_`)).map((m) => m.name))
      expect([set, pieces.size > 0]).toEqual([set, true])
      for (const name of pieces) {
        const meshes = planted.filter((m) => m.name === name)
        // Every instance is drawn once, in the slice it is in.
        expect([name, meshes.reduce((n, m) => n + m.count, 0)]).toEqual([name, list.length / VEG_STRIDE])
        const at = new Matrix4()
        for (const mesh of meshes) {
          for (let k = 0; k < mesh.count; k++) {
            mesh.getMatrixAt(k, at)
            const [x, , z] = at.elements.slice(12, 15)
            // A small set (the palms) is one mesh; the rest are in their slice.
            if (mesh.userData.nkv_sector !== -1) expect([name, vegSector(x, z)]).toEqual([name, mesh.userData.nkv_sector])
            // Beyond the foot of the slope: nothing grows where the character walks.
            expect([name, Math.hypot(x, z) > 33]).toEqual([name, true])
          }
          // The colas take the variety of their terrace; the leaves and the palms are their own colour.
          expect([name, mesh.instanceColor !== null]).toEqual([name, mesh.userData.nkv_instance_tint === 1])
        }
      }
    }
  })

  test("every sign says where the project's name goes, on its board, facing out", async () => {
    const kit = await kitFor(level)
    for (let v = 0; v < kit.variants; v++) {
      const anchor = kit.signOf(v)
      expect([v, anchor !== undefined]).toEqual([v, true])
      const board = piece(kit.shop(v), "board")
      board.geometry.computeBoundingBox()
      const b = board.geometry.boundingBox!
      expect([v, anchor!.width > 0.3, anchor!.height > 0.15]).toEqual([v, true, true])
      const inside = (value: number, lo: number, hi: number) => value >= lo - 0.05 && value <= hi + 0.05
      expect([v, inside(anchor!.x, b.min.x, b.max.x), inside(anchor!.y, b.min.y, b.max.y), inside(anchor!.z, b.min.z, b.max.z)]).toEqual([v, true, true, true])
      // It faces the hologram, more or less: the text is read from the plaza, not from behind the bar.
      expect(Math.abs(anchor!.yaw)).toBeLessThan(Math.PI / 3)
    }
  })

  test("the island's ground is the layout's: where the character walks, the terrain is at islandHeight", async () => {
    const terrain = meshNamed(await plaza(), "island_terrain")
    const pos = terrain.geometry.attributes.position
    let checked = 0
    for (let i = 0; i < pos.count; i++) {
      const p = { x: pos.getX(i), z: pos.getZ(i) }
      const r = Math.hypot(p.x, p.z)
      const onPier = Math.abs(p.x) <= PIER.halfWidth + 0.1 && p.z >= PIER.fromZ - 0.1 && p.z <= PIER.toZ + 0.1
      // The mouth's banks are lowered a few degrees past its edge, where nobody walks.
      const nearMouth = r > MOUTH.radius - 2 && Math.PI - Math.abs(Math.atan2(p.x, -p.z)) < MOUTH.halfAngle + (8 * Math.PI) / 180
      if (r < PLATFORM_RADIUS + 0.05 || r > 33 || onPier || nearMouth) continue
      expect([p.x.toFixed(2), p.z.toFixed(2), near(pos.getY(i), islandHeight(p), 0.02)]).toEqual([p.x.toFixed(2), p.z.toFixed(2), true])
      checked++
    }
    expect(checked).toBeGreaterThan(1000)
  })

  test("the deck is the platform, the pier runs from it to the beach at its height, and the lagoon lies at the water's height", async () => {
    const kit = await kitFor(level)
    const deck = parts(meshNamed(kit.plaza, "island_deck").geometry)[0]
    expect(near(deck.max[1], PLATFORM_TOP, 0.005)).toBe(true)
    expect(near(deck.max[0], PLATFORM_RADIUS, 0.05)).toBe(true)
    const pier = parts(meshNamed(kit.plaza, "island_pier").geometry)
    const planks = pier.filter((b) => near(b.max[1], PIER.top, 0.005))
    expect(planks.length).toBeGreaterThan(10)
    expect(Math.min(...planks.map((b) => b.min[2]))).toBeLessThanOrEqual(PIER.fromZ + 0.05)
    expect(Math.max(...planks.map((b) => b.max[2]))).toBeGreaterThanOrEqual(PIER.toZ - 0.05)
    for (const b of pier) expect(Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]))).toBeLessThanOrEqual(PIER.halfWidth + 0.005)
    const water = meshNamed(kit.plaza, "island_water")
    expect(water.userData.nkv_shade).toBe("water")
    expect(water.geometry.hasAttribute("color")).toBe(true)
    // The file's compression shares one exponent across a vertex's coordinates: its step grows with the distance
    // from the centre (a centimetre at the beach, 12 cm on the far sea). Where the character wades it is exact enough.
    const pos = water.geometry.attributes.position
    for (let i = 0; i < pos.count; i++) {
      if (Math.hypot(pos.getX(i), pos.getZ(i)) > 33) continue
      expect([pos.getX(i).toFixed(1), pos.getZ(i).toFixed(1), near(pos.getY(i), WATER_Y, 0.01)]).toEqual([pos.getX(i).toFixed(1), pos.getZ(i).toFixed(1), true])
    }
  })

  test("the hologram's ring floats at the anchor, and the pedestal is inside what stops the character", async () => {
    const kit = await kitFor(level)
    expect(kit.island).toBe(true)
    expect(kit.ringY).toBeGreaterThan(1)
    expect(kit.ringY).toBeLessThan(3)
    const kerb = parts(meshNamed(kit.plaza, "plaza_kerb").geometry)
    expect(Math.max(...kerb.map((p) => p.max[0]))).toBeLessThanOrEqual(1.75 + 1e-3)
    // Every piece of the projector stands on the deck, under the ring.
    for (const p of parts(meshNamed(kit.plaza, "plaza_base").geometry)) {
      expect(p.min[1]).toBeGreaterThanOrEqual(PLATFORM_TOP - 1e-3)
      expect(p.max[1]).toBeLessThan(PLATFORM_TOP + kit.ringY)
    }
  })

  test("a shop is a fresh group of the same pieces: geometry and materials shared, so a hundred shops cost one", async () => {
    const kit = await kitFor(level)
    for (let v = 0; v < kit.variants; v++) {
      const a = kit.shop(v)
      const b = kit.shop(v)
      expect(a).not.toBe(b)
      expect(a.children.length).toBeGreaterThanOrEqual(8)
      for (let i = 0; i < a.children.length; i++) {
        expect((a.children[i] as Mesh).geometry).toBe((b.children[i] as Mesh).geometry)
        expect((a.children[i] as Mesh).material).toBe((b.children[i] as Mesh).material)
      }
    }
  })

  test("a project's tint changes its accents and nothing else, and shops of the same tint share the tinted material", async () => {
    const kit = await kitFor(level)
    for (let v = 0; v < kit.variants; v++) {
      const plain = kit.shop(v)
      const a = kit.shop(v, SHOP_TINTS[1])
      const b = kit.shop(v, SHOP_TINTS[1])
      for (let i = 0; i < plain.children.length; i++) {
        const mesh = plain.children[i] as Mesh
        const tinted = ["wall", "awning", "accent"].includes(mesh.userData.nkv_tint)
        // What the file calls an accent (the cushions, the umbrellas, the awning's stripes) takes the tint.
        if (/_(accent|stripes)$/.test(mesh.name)) expect([mesh.name, tinted]).toEqual([mesh.name, true])
        expect([mesh.name, (a.children[i] as Mesh).material !== mesh.material]).toEqual([mesh.name, tinted])
        expect((a.children[i] as Mesh).material).toBe((b.children[i] as Mesh).material)
      }
      expect(plain.children.some((c) => c.userData.nkv_tint === "accent")).toBe(true)
    }
  })

  test("every mesh of the file is drawn: none is a group the kit would skip, and each says how it is drawn", async () => {
    const glb = cityGlb(level)
    const nodes = (glb.json.nodes ?? []).filter((n) => n.mesh !== undefined)
    // One primitive a mesh: a mesh of several becomes a group of meshes in the loader, and the kit takes meshes.
    for (const node of nodes) expect([node.name, glb.json.meshes![node.mesh!].primitives.length]).toEqual([node.name, 1])
    const kit = await kitFor(level)
    // A chiringuito's parts are in many shops; what counts is that each is in at least one.
    const drawn = new Set(kit.plaza.children.map((c) => c.name))
    for (let v = 0; v < kit.variants; v++) for (const c of kit.shop(v).children) drawn.add(c.name)
    expect([...drawn].sort()).toEqual(nodes.map((n) => n.name!).sort())
    const shades = ["lit", "vcol", "emit", "add", "mul", "water", "sky"]
    for (const node of nodes) {
      const shade = (node.extras as { nkv_shade?: string } | undefined)?.nkv_shade
      expect([node.name, shades.includes(shade ?? "")]).toEqual([node.name, true])
    }
  })

  test("the lightmaps the file names are KTX2 in the level's folder", () => {
    const glb = cityGlb(level)
    const names = new Set((glb.json.nodes ?? []).flatMap((n) => (n.extras as { nkv_lm?: string } | undefined)?.nkv_lm ?? []))
    expect(names.size).toBeGreaterThan(0)
    for (const name of names) {
      expect(name.endsWith(".ktx2")).toBe(true)
      expect([name, existsSync(join(LEVELS_DIR, level, "lightmap", name))]).toEqual([name, true])
    }
  })

  test("the sky and what hangs on it stay out of the fog, and everything else is in it", async () => {
    const kit = await kitFor(level)
    let sky = 0
    kit.plaza.traverse((o) => {
      const mesh = o as Mesh
      if (!mesh.isMesh) return
      const out = mesh.userData.nkv_fog === 0
      if (out) sky++
      expect([mesh.name, (mesh.material as MeshBasicMaterial).fog]).toEqual([mesh.name, !out])
    })
    expect(sky).toBeGreaterThan(0)
  })
})

describe("which shop a project gets", () => {
  test("the same name gets the same shop, every time, among the ones the file has", () => {
    for (const name of ["nikcli", "docs", "ade", "a very long project name"]) {
      const look = shopLook(name, 3)
      expect(shopLook(name, 3)).toEqual(look)
      expect(look.variant).toBeGreaterThanOrEqual(0)
      expect(look.variant).toBeLessThan(3)
      expect(SHOP_TINTS).toContain(look.tint)
    }
    expect(shopLook("x", 0).variant).toBe(0)
  })

  test("a handful of projects gets more than one shop and more than one colour", () => {
    const looks = ["nikcli", "docs", "ade", "voice", "site", "bench", "infra", "notes"].map((name) => shopLook(name, 3))
    expect(new Set(looks.map((l) => l.variant)).size).toBeGreaterThan(1)
    expect(new Set(looks.map((l) => l.tint)).size).toBeGreaterThan(1)
  })
})
