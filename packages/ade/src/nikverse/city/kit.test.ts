import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { BufferGeometry, Mesh, MeshBasicMaterial, Object3D } from "three/webgpu"
import { readGlb } from "./glb"
import { SHOP_TINTS, shopLook } from "./kit"
import { CHAIR_SEAT_TOP, COMPUTER_HEIGHT, DESKS_PER_SHOP, DESK_HALF, DESK_HEIGHT, DOOR_WIDTH, SHOP_DEPTH, SHOP_WIDTH, WALL_HEIGHT, WALL_THICKNESS, deskLocal, ringRadius, slotCenter, wallsLocal } from "./layout"
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

/** A shop's piece by what it is: `shop2_desk` is the desk of the third shop. */
const piece = (shop: Object3D, what: string) => meshNamed(shop, new RegExp(`^shop\\d*_${what}$`))

const near = (a: number, b: number, tolerance = 0.03) => Math.abs(a - b) <= tolerance

const cityGlb = (level: string) => readGlb(new Uint8Array(readFileSync(join(LEVELS_DIR, level, "city.glb"))))

describe.each(presentLevels())("the city at %s against the layout", (level) => {
  /** Every shop the file has, one after the other. */
  const shops = async () => {
    const kit = await kitFor(level)
    return Array.from({ length: kit.variants }, (_, v) => ({ v, shop: kit.shop(v) }))
  }
  const plaza = async () => (await kitFor(level)).plaza

  /** The x of every vertex of the shell on the front wall (its z between the inner face and the pier's front) below the door's top. */
  const frontEdges = (mesh: Mesh) => {
    const pos = mesh.geometry.attributes.position
    const xs = new Set<string>()
    for (let i = 0; i < pos.count; i++) if (pos.getZ(i) > 2.3 && pos.getZ(i) < 2.7 && pos.getY(i) < 1.7) xs.add(pos.getX(i).toFixed(2))
    return [...xs].map(Number).sort((a, b) => a - b)
  }

  test("the file has a few shops to choose from", async () => {
    expect((await kitFor(level)).variants).toBeGreaterThanOrEqual(3)
  })

  test("the walls of the layout are the pieces of every shell, in the same places", async () => {
    for (const { v, shop } of await shops()) {
      const mesh = piece(shop, "shell")
      const shell = parts(mesh.geometry).filter((p) => p.max[1] > 3.3 && p.max[1] - p.min[1] > 3)
      const walls = wallsLocal()
      expect(walls).toHaveLength(5)
      const isFront = (wall: (typeof walls)[number]) => wall.z > 0
      // The back and the two sides are pieces of their own.
      for (const wall of walls.filter((w) => !isFront(w))) {
        const match = shell.find(
          (p) => near(p.min[0], wall.x - wall.hx) && near(p.max[0], wall.x + wall.hx) && near(p.min[2], wall.z - wall.hz) && near(p.max[2], wall.z + wall.hz),
        )
        expect([v, wall, match !== undefined]).toEqual([v, wall, true])
        expect(near(match!.max[1], wall.height)).toBe(true)
      }
      // The front is one piece with the door cut out of it: its two piers have their edges where the layout's two front walls have theirs.
      const edges = frontEdges(mesh)
      for (const wall of walls.filter(isFront)) {
        expect([v, wall.x - wall.hx, edges.some((x) => near(x, wall.x - wall.hx, 0.01))]).toEqual([v, wall.x - wall.hx, true])
        expect([v, wall.x + wall.hx, edges.some((x) => near(x, wall.x + wall.hx, 0.01))]).toEqual([v, wall.x + wall.hx, true])
      }
      // Outside, the shell is the walls' middle lines and half a wall more.
      expect(near(Math.max(...shell.map((p) => p.max[0])) - Math.min(...shell.map((p) => p.min[0])), SHOP_WIDTH + WALL_THICKNESS)).toBe(true)
      expect(near(Math.max(...shell.map((p) => p.max[2])) - Math.min(...shell.map((p) => p.min[2])), SHOP_DEPTH + WALL_THICKNESS)).toBe(true)
      expect(near(Math.max(...shell.map((p) => p.max[1])), WALL_HEIGHT)).toBe(true)
    }
  })

  test("the gap in the front wall is the door of the layout, and the window's front pane closes it", async () => {
    for (const { v, shop } of await shops()) {
      // Below the door's top the only vertices on the front are the piers': the gap is between the innermost two.
      const edges = frontEdges(piece(shop, "shell"))
      const inner = edges.filter((x) => x < 0).at(-1)!
      const other = edges.find((x) => x > 0)!
      expect([v, near(other - inner, DOOR_WIDTH, 0.01)]).toEqual([v, true])
      // The window is a bay: a front pane and two sides, all as tall as the door (the pool of light it throws is flat).
      const panes = parts(piece(shop, "glass").geometry).filter((p) => p.max[1] - p.min[1] > 2)
      const front = panes.reduce((a, b) => (b.max[0] - b.min[0] > a.max[0] - a.min[0] ? b : a))
      // The glass fills the gap, within a few centimetres of frame each side, in front of the door.
      expect(front.max[0] - front.min[0]).toBeLessThanOrEqual(DOOR_WIDTH)
      expect(front.max[0] - front.min[0]).toBeGreaterThan(DOOR_WIDTH - 0.3)
      expect(front.min[2]).toBeGreaterThan(SHOP_DEPTH / 2)
    }
  })

  test("the desks are the layout's desks: four, of the layout's size and height, in its places", async () => {
    for (const { v, shop } of await shops()) {
      const tops = parts(piece(shop, "desk").geometry).filter((p) => p.max[1] > DESK_HEIGHT - 0.05 && p.max[1] - p.min[1] < 0.2)
      expect([v, tops.length]).toEqual([v, DESKS_PER_SHOP])
      for (let i = 0; i < DESKS_PER_SHOP; i++) {
        const at = deskLocal(i).desk
        const top = tops.find((p) => near(p.center[0], at.x) && near(p.center[2], at.z))
        expect([v, i, top !== undefined]).toEqual([v, i, true])
        expect(near(top!.max[0] - top!.min[0], DESK_HALF.hx * 2)).toBe(true)
        expect(near(top!.max[2] - top!.min[2], DESK_HALF.hz * 2)).toBe(true)
        expect(near(top!.max[1], DESK_HEIGHT)).toBe(true)
      }
    }
  })

  test("the chairs are where the people sit, with the seat at the height the pelvis is seated at", async () => {
    for (const { v, shop } of await shops()) {
      const seats = parts(piece(shop, "chair").geometry).filter((p) => near(p.max[1], CHAIR_SEAT_TOP, 0.02) && p.max[1] - p.min[1] < 0.15)
      expect([v, seats.length]).toEqual([v, DESKS_PER_SHOP])
      for (let i = 0; i < DESKS_PER_SHOP; i++) {
        const at = deskLocal(i).chair
        expect([v, i, seats.some((p) => near(p.center[0], at.x) && near(p.center[2], at.z))]).toEqual([v, i, true])
      }
    }
  })

  test("the monitors are the layout's computers: their middle at its height, their face where the glow is drawn", async () => {
    for (const { v, shop } of await shops()) {
      const screens = parts(piece(shop, "props").geometry).filter((p) => p.max[0] - p.min[0] > 0.5 && p.max[1] - p.min[1] > 0.3)
      expect([v, screens.length]).toEqual([v, DESKS_PER_SHOP])
      for (let i = 0; i < DESKS_PER_SHOP; i++) {
        const at = deskLocal(i).computer
        const screen = screens.find((p) => near(p.center[0], at.x) && near(p.center[2], at.z))
        expect([v, i, screen !== undefined]).toEqual([v, i, true])
        expect(near(screen!.center[1], COMPUTER_HEIGHT)).toBe(true)
        // The glow plane stands 3.5 cm in front of the middle, on the side the person sits: past the panel's front face.
        expect(screen!.max[2]).toBeLessThan(at.z + 0.035)
      }
    }
  })

  test("the plots on the paving are the twelve slots of the first ring, in its places", async () => {
    const plots = parts(meshNamed(await plaza(), "plaza_lots").geometry)
    expect(plots).toHaveLength(12)
    const wanted = Array.from({ length: 12 }, (_, slot) => slotCenter(slot))
    for (const slot of wanted) {
      expect([slot.x, slot.z, plots.some((p) => Math.hypot(p.center[0] - slot.x, p.center[2] - slot.z) < 0.5)]).toEqual([slot.x, slot.z, true])
    }
    for (const plot of plots) expect(near(Math.hypot(plot.center[0], plot.center[2]), ringRadius(0), 0.2)).toBe(true)
  })

  test("the paving reaches past the first ring, the hologram's ring floats at the anchor, and the pedestal is inside what stops the character", async () => {
    const kit = await kitFor(level)
    const ground = parts(meshNamed(kit.plaza, "plaza_slabs").geometry)[0]
    expect(ground.max[0]).toBeGreaterThan(ringRadius(0) + SHOP_WIDTH / 2)
    expect(near(ground.max[1], 0, 0.001)).toBe(true)
    expect(kit.ringY).toBeGreaterThan(1)
    expect(kit.ringY).toBeLessThan(3)
    const kerb = parts(meshNamed(kit.plaza, "plaza_kerb").geometry)
    expect(Math.max(...kerb.map((p) => p.max[0]))).toBeLessThanOrEqual(3.1 + 1e-6)
  })

  test("what the character walks on is flat at the ground's height, out to the far side of the road", async () => {
    const kit = await kitFor(level)
    for (const name of ["plaza_setts", "plaza_slabs", "env_garden", "env_road", "env_walk_out"]) {
      const box = parts(meshNamed(kit.plaza, name).geometry)
      const low = Math.min(...box.map((p) => p.min[1]))
      const high = Math.max(...box.map((p) => p.max[1]))
      expect([name, near(low, 0, 0.01) && near(high, 0, 0.01)]).toEqual([name, true])
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

  test("a project's tint changes its walls and awning and nothing else, and shops of the same tint share the tinted material", async () => {
    const kit = await kitFor(level)
    const plain = kit.shop(0)
    const a = kit.shop(0, SHOP_TINTS[1])
    const b = kit.shop(0, SHOP_TINTS[1])
    for (let i = 0; i < plain.children.length; i++) {
      const mesh = plain.children[i] as Mesh
      const tinted = mesh.userData.nkv_tint === "wall" || mesh.userData.nkv_tint === "awning"
      expect([mesh.name, (a.children[i] as Mesh).material !== mesh.material]).toEqual([mesh.name, tinted])
      expect((a.children[i] as Mesh).material).toBe((b.children[i] as Mesh).material)
    }
    expect(plain.children.some((c) => c.userData.nkv_tint === "wall")).toBe(true)
  })

  test("every mesh of the file is drawn: none is a group the kit would skip, and each says how it is drawn", async () => {
    const glb = cityGlb(level)
    const nodes = (glb.json.nodes ?? []).filter((n) => n.mesh !== undefined)
    // One primitive a mesh: a mesh of several becomes a group of meshes in the loader, and the kit takes meshes.
    for (const node of nodes) expect([node.name, glb.json.meshes![node.mesh!].primitives.length]).toEqual([node.name, 1])
    const kit = await kitFor(level)
    let drawn = kit.plaza.children.length
    for (let v = 0; v < kit.variants; v++) drawn += kit.shop(v).children.length
    expect(drawn).toBe(nodes.length)
    const shades = ["lit", "vcol", "emit", "add", "mul"]
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
