/**
 * Where things stand in the city. Metres; x to the right, z toward the viewer,
 * y up. The square is the origin, the shops stand on rings around it.
 *
 * Nothing here knows about three.js: a placement is numbers, so the tests can
 * say where a wall is, where a desk is and whether the door faces the square.
 */

/** The square's radius: the hologram and the projector stand in it. */
export const PLAZA_RADIUS = 14
export const RING_SLOTS = 12
/**
 * Radius of ring 0, where N3's plaza has its twelve plots; each next ring is `RING_STEP` further, out on the
 * plain beyond the paving.
 */
const RING_FIRST = 19
const RING_STEP = 12
/** Ground beyond the last ring the world lets the character reach. */
export const WORLD_MARGIN = 22

/**
 * A shop's outside, and the wall around it: N3's shop, measured off `city.glb` (the tests hold these to the
 * file). The sizes are between the walls' middle lines; the outside is a wall's thickness more.
 */
export const SHOP_WIDTH = 6
export const SHOP_DEPTH = 5
export const WALL_THICKNESS = 0.18
export const WALL_HEIGHT = 3.4
/** The gap in the front wall: it is a shop window and a way in. */
export const DOOR_WIDTH = 3.8
export const DESKS_PER_SHOP = 4

export const ringOf = (slot: number) => Math.floor(slot / RING_SLOTS)
export const ringRadius = (ring: number) => RING_FIRST + RING_STEP * ring

/** How far from the centre the character may walk with `rings` rings in use. */
export const worldRadius = (slots: number[]) =>
  ringRadius(slots.length ? Math.max(...slots.map(ringOf)) : 0) + WORLD_MARGIN

export interface Vec2 {
  x: number
  z: number
}

/**
 * Where slot `n` stands. The angle counts clockwise seen from above, from the
 * direction the character first looks at, so slot 0 is straight ahead.
 */
export function slotCenter(slot: number): Vec2 & { angle: number } {
  const angle = ((slot % RING_SLOTS) / RING_SLOTS) * Math.PI * 2
  const radius = ringRadius(ringOf(slot))
  return { x: Math.sin(angle) * radius, z: -Math.cos(angle) * radius, angle }
}

/** An oriented box on the ground, and how high it is. `yaw` turns it counter-clockwise from above. */
export interface Box {
  cx: number
  cz: number
  hx: number
  hz: number
  yaw: number
  /** Height, for a ray; the ground collision ignores it. */
  height: number
}

export interface Placement {
  slot: number
  center: Vec2
  /** The shop's turn: its door (local +z) faces the square. */
  yaw: number
}

export function placementOf(slot: number): Placement {
  const c = slotCenter(slot)
  // Local +z must point at the origin: direction (-x, -z), so yaw = atan2 of the wanted x, z after rotating (0, 1).
  // rotateY(yaw) sends (0, 1) to (sin yaw, cos yaw).
  const yaw = Math.atan2(-c.x, -c.z)
  return { slot, center: { x: c.x, z: c.z }, yaw }
}

/** A point of the shop's own frame, in the world. */
export function toWorld(p: Placement, local: Vec2): Vec2 {
  const s = Math.sin(p.yaw)
  const c = Math.cos(p.yaw)
  return { x: p.center.x + local.x * c + local.z * s, z: p.center.z - local.x * s + local.z * c }
}

/** A world point in the shop's own frame. */
export function toLocal(p: Placement, world: Vec2): Vec2 {
  const dx = world.x - p.center.x
  const dz = world.z - p.center.z
  const s = Math.sin(p.yaw)
  const c = Math.cos(p.yaw)
  return { x: dx * c - dz * s, z: dx * s + dz * c }
}

/** A box given in the shop's frame, as a world box. */
function worldBox(p: Placement, local: { x: number; z: number; hx: number; hz: number; height: number }): Box {
  const c = toWorld(p, { x: local.x, z: local.z })
  return { cx: c.x, cz: c.z, hx: local.hx, hz: local.hz, yaw: p.yaw, height: local.height }
}

export interface LocalBox {
  x: number
  z: number
  hx: number
  hz: number
  height: number
}

/** The walls of a shop, in its own frame: back, both sides, and the front with a gap for the door. */
export function wallsLocal(): LocalBox[] {
  const w = SHOP_WIDTH / 2
  const d = SHOP_DEPTH / 2
  const t = WALL_THICKNESS / 2
  const side = (SHOP_WIDTH - DOOR_WIDTH) / 4
  const doorEdge = DOOR_WIDTH / 2
  return [
    { x: 0, z: -d, hx: w, hz: t, height: WALL_HEIGHT },
    { x: -w, z: 0, hx: t, hz: d, height: WALL_HEIGHT },
    { x: w, z: 0, hx: t, hz: d, height: WALL_HEIGHT },
    { x: -(doorEdge + side), z: d, hx: side, hz: t, height: WALL_HEIGHT },
    { x: doorEdge + side, z: d, hx: side, hz: t, height: WALL_HEIGHT },
  ]
}

/** Two rows of two: the front row sits in the window, the back row behind it; everyone faces the back wall. */
const DESK_ROWS = [-0.55, 1.08]
const DESK_COLUMNS = 2
const DESK_PITCH = 2.15

/** Where desk `i` stands in the shop's frame; the person sits behind it, facing the back wall. */
export function deskLocal(i: number): { desk: Vec2; computer: Vec2; chair: Vec2 } {
  const col = i % DESK_COLUMNS
  const row = Math.floor(i / DESK_COLUMNS)
  const x = (col - (DESK_COLUMNS - 1) / 2) * DESK_PITCH
  const z = DESK_ROWS[row]
  return { desk: { x, z }, computer: { x, z: z - 0.18 }, chair: { x, z: z + 0.48 } }
}

/** The desk's own size (half extents), for its box and its mesh. */
export const DESK_HALF = { hx: 0.805, hz: 0.4 }
export const DESK_HEIGHT = 0.75
/** The middle of a monitor's screen, above the floor. */
export const COMPUTER_HEIGHT = 0.99
/** The top of a chair's seat, above the floor: what a rigged person is seated at. */
export const CHAIR_SEAT_TOP = 0.5

/** Where a person stands when the shop has no free desk: along the inside of the back wall, behind the desks. */
export function standLocal(i: number): Vec2 {
  const per = 5
  const n = i % per
  // Two rows behind the desks, along the back wall; past ten they stand in each other's place.
  return { x: (n - (per - 1) / 2) * 1.1, z: -SHOP_DEPTH / 2 + 0.9 - (Math.floor(i / per) % 2) * 0.5 }
}

/** The boxes a shop puts on the ground: its walls and its desks. */
export function shopBoxes(p: Placement, desks: number): Box[] {
  const boxes = wallsLocal().map((b) => worldBox(p, b))
  for (let i = 0; i < Math.min(desks, DESKS_PER_SHOP); i++) {
    const d = deskLocal(i).desk
    // A desk stops the character 10 cm short of its top's edge, which overhangs its legs: without that the strip
    // between the front row and the front wall (0.41 m) is narrower than a body, and a dead end nobody meant.
    boxes.push(worldBox(p, { x: d.x, z: d.z, hx: DESK_HALF.hx, hz: DESK_HALF.hz - 0.1, height: DESK_HEIGHT }))
  }
  return boxes
}

/**
 * Slots for the shops in ADE's picture, kept from one picture to the next.
 *
 * ADE gives each shop a slot in the order projects were opened. A slot that is
 * free is honoured; one that two shops claim, or that is missing, goes to the
 * lowest free slot, shops taken in id order. A shop that was placed keeps its
 * place while it exists, so a new project never moves the others.
 */
export function placeShops(
  shops: ReadonlyArray<{ id: string; slot?: number }>,
  kept: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>()
  const taken = new Set<number>()
  const ids = new Set(shops.map((s) => s.id))
  for (const [id, slot] of kept) {
    if (ids.has(id) && !taken.has(slot)) {
      out.set(id, slot)
      taken.add(slot)
    }
  }
  const rest = shops.filter((s) => !out.has(s.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const s of rest) {
    const asked = Number.isInteger(s.slot) && (s.slot as number) >= 0 ? (s.slot as number) : undefined
    let slot = asked !== undefined && !taken.has(asked) ? asked : 0
    while (taken.has(slot)) slot++
    out.set(s.id, slot)
    taken.add(slot)
  }
  return out
}
