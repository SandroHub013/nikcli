import { describe, expect, test } from "bun:test"
import type { BufferGeometry, Mesh, Object3D } from "three/webgpu"
import { CHAIR_SEAT_TOP, COMPUTER_HEIGHT, DESKS_PER_SHOP, DESK_HALF, DESK_HEIGHT, DOOR_WIDTH, SHOP_DEPTH, SHOP_WIDTH, WALL_HEIGHT, WALL_THICKNESS, deskLocal, ringRadius, slotCenter, wallsLocal } from "./layout"
import { kitFor, presentLevels } from "./test-cast"

/**
 * The layout is numbers and the shop is a mesh; these hold the two to each other, on N3's real `city.glb`:
 * what the code says is a wall, a desk, a chair or a monitor is where the file draws one.
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

const meshNamed = (root: Object3D, name: string): Mesh => {
  let found: Mesh | undefined
  root.traverse((o) => {
    if (!found && o.name === name && (o as Mesh).isMesh) found = o as Mesh
  })
  if (!found) throw new Error(`no ${name} in the file`)
  return found
}

const near = (a: number, b: number, tolerance = 0.03) => Math.abs(a - b) <= tolerance

describe.each(presentLevels())("N3's city at %s against the layout", (level) => {
  const shop = async () => (await kitFor(level)).shop()
  const plaza = async () => (await kitFor(level)).plaza

  /** The x of every vertex of the shell that is on the front wall (its z is past the inner face) below the door's top. */
  const frontEdges = (mesh: Mesh) => {
    const pos = mesh.geometry.attributes.position
    const xs = new Set<string>()
    for (let i = 0; i < pos.count; i++) if (pos.getZ(i) > 2.3 && pos.getY(i) < 1.7) xs.add(pos.getX(i).toFixed(2))
    return [...xs].map(Number).sort((a, b) => a - b)
  }

  test("the walls of the layout are the pieces of the shell, in the same places", async () => {
    const mesh = meshNamed(await shop(), "shop_shell")
    const shell = parts(mesh.geometry).filter((p) => p.max[1] > 3.3 && p.max[1] - p.min[1] > 3)
    const walls = wallsLocal()
    expect(walls).toHaveLength(5)
    const isFront = (wall: (typeof walls)[number]) => wall.z > 0
    // The back and the two sides are pieces of their own.
    for (const wall of walls.filter((w) => !isFront(w))) {
      const match = shell.find(
        (p) => near(p.min[0], wall.x - wall.hx) && near(p.max[0], wall.x + wall.hx) && near(p.min[2], wall.z - wall.hz) && near(p.max[2], wall.z + wall.hz),
      )
      expect([wall, match !== undefined]).toEqual([wall, true])
      expect(near(match!.max[1], wall.height)).toBe(true)
    }
    // The front is one piece with the door cut out of it: its two piers have their edges where the layout's two front walls have theirs.
    const edges = frontEdges(mesh)
    for (const wall of walls.filter(isFront)) {
      expect([wall.x - wall.hx, edges.some((x) => near(x, wall.x - wall.hx, 0.01))]).toEqual([wall.x - wall.hx, true])
      expect([wall.x + wall.hx, edges.some((x) => near(x, wall.x + wall.hx, 0.01))]).toEqual([wall.x + wall.hx, true])
    }
    // Outside, the shell is the walls' middle lines and half a wall more.
    expect(near(Math.max(...shell.map((p) => p.max[0])) - Math.min(...shell.map((p) => p.min[0])), SHOP_WIDTH + WALL_THICKNESS)).toBe(true)
    expect(near(Math.max(...shell.map((p) => p.max[2])) - Math.min(...shell.map((p) => p.min[2])), SHOP_DEPTH + WALL_THICKNESS)).toBe(true)
    expect(near(Math.max(...shell.map((p) => p.max[1])), WALL_HEIGHT)).toBe(true)
  })

  test("the gap in the front wall is the door of the layout, and the window closes it", async () => {
    const group = await shop()
    // Below the door's top the only vertices on the front are the piers': the gap is between the innermost two.
    const edges = frontEdges(meshNamed(group, "shop_shell"))
    const inner = edges.filter((x) => x < 0).at(-1)!
    const other = edges.find((x) => x > 0)!
    expect(near(other - inner, DOOR_WIDTH, 0.01)).toBe(true)
    const glass = parts(meshNamed(group, "shop_glass").geometry)
    expect(glass).toHaveLength(1)
    // The glass fills the gap, within a few centimetres of frame each side.
    expect(glass[0].max[0] - glass[0].min[0]).toBeLessThanOrEqual(DOOR_WIDTH)
    expect(glass[0].max[0] - glass[0].min[0]).toBeGreaterThan(DOOR_WIDTH - 0.3)
  })

  test("the desks are the layout's desks: four, of the layout's size and height, in its places", async () => {
    const tops = parts(meshNamed(await shop(), "shop_desk").geometry).filter((p) => p.max[1] > DESK_HEIGHT - 0.05 && p.max[1] - p.min[1] < 0.2)
    expect(tops).toHaveLength(DESKS_PER_SHOP)
    for (let i = 0; i < DESKS_PER_SHOP; i++) {
      const at = deskLocal(i).desk
      const top = tops.find((p) => near(p.center[0], at.x) && near(p.center[2], at.z))
      expect([i, top !== undefined]).toEqual([i, true])
      expect(near(top!.max[0] - top!.min[0], DESK_HALF.hx * 2)).toBe(true)
      expect(near(top!.max[2] - top!.min[2], DESK_HALF.hz * 2)).toBe(true)
      expect(near(top!.max[1], DESK_HEIGHT)).toBe(true)
    }
  })

  test("the chairs are where the people sit, with the seat at the height the pelvis is seated at", async () => {
    const seats = parts(meshNamed(await shop(), "shop_chair").geometry).filter((p) => near(p.max[1], CHAIR_SEAT_TOP, 0.02) && p.max[1] - p.min[1] < 0.15)
    expect(seats).toHaveLength(DESKS_PER_SHOP)
    for (let i = 0; i < DESKS_PER_SHOP; i++) {
      const at = deskLocal(i).chair
      expect([i, seats.some((p) => near(p.center[0], at.x) && near(p.center[2], at.z))]).toEqual([i, true])
    }
  })

  test("the monitors are the layout's computers: their middle at its height, their face where the glow is drawn", async () => {
    const screens = parts(meshNamed(await shop(), "shop_props").geometry).filter((p) => p.max[0] - p.min[0] > 0.5 && p.max[1] - p.min[1] > 0.3)
    expect(screens).toHaveLength(DESKS_PER_SHOP)
    for (let i = 0; i < DESKS_PER_SHOP; i++) {
      const at = deskLocal(i).computer
      const screen = screens.find((p) => near(p.center[0], at.x) && near(p.center[2], at.z))
      expect([i, screen !== undefined]).toEqual([i, true])
      expect(near(screen!.center[1], COMPUTER_HEIGHT)).toBe(true)
      // The glow plane stands 3.5 cm in front of the middle, on the side the person sits: past the panel's front face.
      expect(screen!.max[2]).toBeLessThan(at.z + 0.035)
    }
  })

  test("the plots on the paving are the twelve slots of the first ring, in its places", async () => {
    const plots = parts(meshNamed(await plaza(), "plaza_prop").geometry)
    expect(plots).toHaveLength(12)
    const wanted = Array.from({ length: 12 }, (_, slot) => slotCenter(slot))
    for (const slot of wanted) {
      expect([slot.x, slot.z, plots.some((p) => Math.hypot(p.center[0] - slot.x, p.center[2] - slot.z) < 0.5)]).toEqual([slot.x, slot.z, true])
    }
    for (const plot of plots) expect(near(Math.hypot(plot.center[0], plot.center[2]), ringRadius(0), 0.2)).toBe(true)
  })

  test("the paving reaches past the first ring, the hologram's ring floats at the anchor, and the pedestal is inside what stops the character", async () => {
    const kit = await kitFor(level)
    const ground = parts(meshNamed(kit.plaza, "plaza_ground").geometry)[0]
    expect(ground.max[0]).toBeGreaterThan(ringRadius(0) + SHOP_WIDTH / 2)
    expect(near(ground.max[1], 0, 0.001)).toBe(true)
    expect(kit.ringY).toBeGreaterThan(1)
    expect(kit.ringY).toBeLessThan(3)
    const kerb = parts(meshNamed(kit.plaza, "plaza_kerb").geometry)
    expect(Math.max(...kerb.map((p) => p.max[0]))).toBeLessThanOrEqual(3.1 + 1e-6)
  })

  test("a shop is a fresh group of the same pieces: geometry and materials shared, so a hundred shops cost one", async () => {
    const kit = await kitFor(level)
    const a = kit.shop()
    const b = kit.shop()
    expect(a).not.toBe(b)
    expect(a.children.length).toBeGreaterThanOrEqual(8)
    for (let i = 0; i < a.children.length; i++) {
      expect((a.children[i] as Mesh).geometry).toBe((b.children[i] as Mesh).geometry)
      expect((a.children[i] as Mesh).material).toBe((b.children[i] as Mesh).material)
    }
  })
})
