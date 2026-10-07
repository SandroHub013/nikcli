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
 * Radius of ring 0: the island's beach, where the chiringuiti stand with their bars toward the hologram; each next
 * ring is `RING_STEP` further, on terraces cut into the slope.
 */
const RING_FIRST = 28
const RING_STEP = 12
/** Ground beyond the last ring the world lets the character reach: from the beach to the foot of the slope. */
export const WORLD_MARGIN = 5
/** The slots' angles: `SLOT_FIRST` either side of straight ahead, then `SLOT_STEP` apart, so the lagoon's mouth stays free. */
const SLOT_FIRST = 13
const SLOT_STEP = 26

/**
 * The lagoon's mouth: deep water to the south (straight behind the first look), `halfAngle` either side of it and
 * past `radius`. The character does not walk there.
 */
export const MOUTH = { halfAngle: (37 * Math.PI) / 180, radius: 19 }

/** The platform the hologram stands on, at the island's centre: its radius and the height of its deck. */
export const PLATFORM_RADIUS = 6
export const PLATFORM_TOP = 0.3
/** The lagoon's surface: its floor is the ground the character wades on, 18 cm under it. */
export const WATER_Y = 0.18

/**
 * The island's ground along a radius, as (radius, height) points joined by straight lines: the deck, a step down to
 * the islet's sand (dry to r 8.3), the lagoon's floor, the beach rising to where the chiringuiti stand, the foot of the slope. The
 * generator builds the terrain from the same points.
 */
export const ISLAND_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0, PLATFORM_TOP],
  [PLATFORM_RADIUS, PLATFORM_TOP],
  [PLATFORM_RADIUS + 1e-3, 0.24],
  [8, 0.22],
  [9.5, 0],
  [17.5, 0],
  [19.5, 0.3],
  [24.5, 0.45],
  [31.5, 0.45],
  [33, 0.8],
]

/** The pier from the islet to the north beach, straight ahead of the spawn: its half width, where it runs, its deck. */
export const PIER = { halfWidth: 1.1, fromZ: -19.5, toZ: -7.2, top: PLATFORM_TOP }

/**
 * How far the beach's shore comes out into the lagoon (positive) or goes back (m), by the angle clockwise from
 * straight ahead: the generator's `shore_wobble`, so the shore is not a circle.
 */
export function shoreWobble(p: Vec2): number {
  const a = Math.atan2(p.x, -p.z)
  return 1.2 * Math.sin(3 * a + 0.4) + 0.7 * Math.sin(7 * a + 1.3) + 0.4 * Math.sin(13 * a + 2.1)
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Where the shore moves: on the beach's waterline, not on the islet nor under the chiringuiti. */
const shoreBand = (r: number) => smooth(13, 16, r) * (1 - smooth(22, 25, r))

/**
 * The height of the island's ground under a point: the profile along the radius, the pier's deck over it, and the
 * Faro's boardwalk and deck (`WALKWAYS`), which stand over the lagoon and the mouth at their own height.
 */
export function islandHeight(p: Vec2): number {
  const walkway = onWalkway(p)
  if (walkway) return walkway.height
  const r = Math.hypot(p.x, p.z)
  const ground = profileHeight(r - shoreWobble(p) * shoreBand(r))
  const onPier = Math.abs(p.x) <= PIER.halfWidth && p.z >= PIER.fromZ && p.z <= PIER.toZ
  return onPier ? Math.max(ground, PIER.top) : ground
}

function profileHeight(r: number): number {
  const last = ISLAND_PROFILE[ISLAND_PROFILE.length - 1]
  if (r >= last[0]) return last[1]
  for (let i = 1; i < ISLAND_PROFILE.length; i++) {
    const [r1, h1] = ISLAND_PROFILE[i]
    if (r <= r1) {
      const [r0, h0] = ISLAND_PROFILE[i - 1]
      return h0 + ((h1 - h0) * (r - r0)) / (r1 - r0)
    }
  }
  return last[1]
}

/**
 * A project's chiringuito, in its own frame (+z toward the hologram): a thatched roof on four posts over a
 * counter, with the back bar and its bottles behind, loungers and umbrellas in front toward the water. The front
 * is open. `SHOP_WIDTH` by `SHOP_DEPTH` is the roof's footprint; the tests hold these numbers to `city.glb`.
 */
export const SHOP_WIDTH = 6
export const SHOP_DEPTH = 5
/** Where the roof starts, over the posts, and its top: what a chiringuito must sink by to be under the sand. */
export const EAVE_HEIGHT = 2.55
export const ROOF_TOP = 4
export const DESKS_PER_SHOP = 4

/** The counter: the bar the first two seats work at, its front toward the hologram. */
export const COUNTER = { x: 0, z: 0.3, hx: 1.8, hz: 0.28, height: 0.75 }
/** The back bar with its shelves of bottles, along the back of the roof. */
export const BACK_BAR = { x: 0, z: -2.3, hx: 2.6, hz: 0.2, height: 2 }
/** The four posts under the roof's corners. */
export const POSTS: ReadonlyArray<Vec2> = [
  { x: -2.8, z: -2.3 },
  { x: 2.8, z: -2.3 },
  { x: -2.8, z: 0.75 },
  { x: 2.8, z: 0.75 },
]
export const POST_HALF = 0.09
/** Three loungers on the sand in front, toward the water, their heads toward the chiringuito. */
export const LOUNGERS: ReadonlyArray<Vec2> = [
  { x: -2.3, z: 3.9 },
  { x: 0, z: 3.9 },
  { x: 2.3, z: 3.9 },
]
export const LOUNGER_HALF = { hx: 0.33, hz: 0.95, height: 0.45 }
/** Two potted plants either side of the front, outside the posts: the only plants near the people (plan I1). */
export const POTS: ReadonlyArray<Vec2> = [
  { x: -3.35, z: 0.2 },
  { x: 3.35, z: 0.2 },
]
export const POT_HALF = { hx: 0.3, hz: 0.3, height: 1.0 }

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
 * The angle of slot `n`, clockwise seen from above from the direction the character first looks at: the slots go
 * out from straight ahead in pairs, 13° to the right then 13° to the left, then 26° further each pair, so a handful
 * of projects stands in front of the spawn and the last pair is at the edges of the lagoon's mouth (±143°).
 */
export function slotAngle(slot: number): number {
  const k = slot % RING_SLOTS
  const sign = k % 2 === 0 ? 1 : -1
  return (sign * (SLOT_FIRST + SLOT_STEP * Math.floor(k / 2)) * Math.PI) / 180
}

/** Where slot `n` stands (its angle is `slotAngle`). */
export function slotCenter(slot: number): Vec2 & { angle: number } {
  const angle = slotAngle(slot)
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

/**
 * What stops the character in a chiringuito, in its own frame: the back bar, the counter, the posts and the
 * loungers. The front is open: behind the counter is reached round its ends.
 */
export function wallsLocal(): LocalBox[] {
  return [
    BACK_BAR,
    COUNTER,
    ...POSTS.map((p) => ({ x: p.x, z: p.z, hx: POST_HALF, hz: POST_HALF, height: EAVE_HEIGHT })),
    ...LOUNGERS.map((l) => ({ x: l.x, z: l.z, ...LOUNGER_HALF })),
    ...POTS.map((p) => ({ x: p.x, z: p.z, ...POT_HALF })),
  ]
}

/**
 * The four seats: 0 and 1 are stools at the counter, with the laptop on it; 2 and 3 are small tables on the sand in
 * front, either side. Everyone sits on the hologram's side of their table, facing the back bar.
 */
const SEATS: ReadonlyArray<Vec2> = [
  { x: -0.85, z: COUNTER.z },
  { x: 0.85, z: COUNTER.z },
  { x: -2.05, z: 1.75 },
  { x: 2.05, z: 1.75 },
]

/** Where seat `i` is in the shop's frame: its table (or its stretch of counter), the laptop on it, the chair. */
export function deskLocal(i: number): { desk: Vec2; computer: Vec2; chair: Vec2 } {
  const { x, z } = SEATS[i % SEATS.length]
  return { desk: { x, z }, computer: { x, z: z - 0.18 }, chair: { x, z: z + 0.48 } }
}

/** A small table's own size (half extents), for its box and its mesh; a seat at the counter has as much of it. */
export const DESK_HALF = { hx: 0.45, hz: 0.3 }
export const DESK_HEIGHT = 0.75
/** The middle of a laptop's screen, above the ground. */
export const COMPUTER_HEIGHT = 0.86
/** The top of a chair's seat, above the floor: what a rigged person is seated at. */
export const CHAIR_SEAT_TOP = 0.5

/** Where a person stands when the chiringuito has no free seat: behind the counter, facing the hologram. */
export function standLocal(i: number): Vec2 {
  const per = 5
  const n = i % per
  // Two rows between the counter and the back bar; past ten they stand in each other's place.
  return { x: (n - (per - 1) / 2) * 0.85, z: -0.55 - (Math.floor(i / per) % 2) * 0.6 }
}

/** The boxes a chiringuito puts on the ground: its fixed pieces, and the small tables in use. */
export function shopBoxes(p: Placement, desks: number): Box[] {
  const boxes = wallsLocal().map((b) => worldBox(p, b))
  for (let i = 0; i < Math.min(desks, DESKS_PER_SHOP); i++) {
    // The counter's seats are in the counter's box already.
    if (SEATS[i].z === COUNTER.z) continue
    const d = deskLocal(i).desk
    boxes.push(worldBox(p, { x: d.x, z: d.z, hx: DESK_HALF.hx, hz: DESK_HALF.hz, height: DESK_HEIGHT }))
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

/**
 * The Faro, where the lessons open: a lighthouse on a rock in the lagoon's mouth, behind the first look, past the
 * last pair of chiringuiti (±143°), so it takes no project's slot. It stands 6.5 m east of the mouth's middle
 * (about 165°, r 25): straight behind the hologram, the hologram's light hid it from the north shore; here it is
 * the second silhouette beside it, against the sunset.
 *
 * The mouth's arms are where slots 10 and 11 stand (r 28, ±143°), so the boardwalk does not start there: it runs
 * from the islet's sand across the lagoon, straight south like the pier, onto a square deck round the tower.
 * `deckHalf` is the deck's half side, `towerRadius` the tower's foot, `towerTop` the tip of its cap.
 */
export const FARO = { x: 6.5, z: 24, deckHalf: 2.6, towerRadius: 1.2, towerTop: 11.4, top: PLATFORM_TOP }
/**
 * The boardwalk: its half width, where it runs (from the islet's sand to the deck), and where its rails start,
 * before the mouth begins under it.
 */
export const FARO_WALK = { halfWidth: 0.8, fromZ: 4, toZ: FARO.z - FARO.deckHalf, railsFromZ: 16.5 }
/** The rails: half their thickness, and their height above the deck. */
export const RAIL_HALF = 0.05
export const RAIL_HEIGHT = 1
/** The Faro's door, on the tower's north face toward the islet: what a click or `E` presses. */
export const FARO_DOOR = { x: FARO.x, y: FARO.top + 1, z: FARO.z - FARO.towerRadius - 0.05, radius: 0.6 }

/**
 * Ground over the water that the character walks on, mouth or not: the boardwalk and the deck. A box whose
 * `height` is its deck's top. Inside one, the mouth does not push the character back (`collision.ts`): the rails
 * (`faroBoxes`) keep it on the planks, so no wall is invisible.
 */
export const WALKWAYS: ReadonlyArray<Box> = [
  {
    cx: FARO.x,
    cz: (FARO_WALK.fromZ + FARO_WALK.toZ) / 2,
    hx: FARO_WALK.halfWidth,
    hz: (FARO_WALK.toZ - FARO_WALK.fromZ) / 2,
    yaw: 0,
    height: FARO.top,
  },
  { cx: FARO.x, cz: FARO.z, hx: FARO.deckHalf, hz: FARO.deckHalf, yaw: 0, height: FARO.top },
]

/** Whether a point is inside a box on the ground, grown by `margin`. */
export function inBox(p: Vec2, box: Box, margin = 0): boolean {
  const s = Math.sin(box.yaw)
  const c = Math.cos(box.yaw)
  const dx = p.x - box.cx
  const dz = p.z - box.cz
  return Math.abs(dx * c - dz * s) <= box.hx + margin && Math.abs(dx * s + dz * c) <= box.hz + margin
}

/** The walkway a point stands on, if any. */
export function onWalkway(p: Vec2, margin = 0): Box | undefined {
  return WALKWAYS.find((w) => inBox(p, w, margin))
}

/**
 * What stops the character at the Faro: the tower, as four boxes crossed every 45° (round to 10 cm, where one
 * square would stick out half a metre at its corners), and the rails, along the boardwalk where it leaves the
 * wading lagoon and round the deck, open where the boardwalk comes in.
 */
export function faroBoxes(): Box[] {
  const { x, z, deckHalf: d, towerRadius: r, towerTop } = FARO
  const rail = FARO.top + RAIL_HEIGHT
  const w = FARO_WALK.halfWidth
  const along = (FARO_WALK.toZ - FARO_WALK.railsFromZ) / 2
  const north = (d + 2 * RAIL_HALF - w) / 2
  const edge = d + RAIL_HALF
  const tower = [0, 1, 2, 3].map((k): Box => ({ cx: x, cz: z, hx: r, hz: 0.5, yaw: (k * Math.PI) / 4, height: towerTop }))
  return [
    ...tower,
    { cx: x - w - RAIL_HALF, cz: FARO_WALK.railsFromZ + along, hx: RAIL_HALF, hz: along, yaw: 0, height: rail },
    { cx: x + w + RAIL_HALF, cz: FARO_WALK.railsFromZ + along, hx: RAIL_HALF, hz: along, yaw: 0, height: rail },
    { cx: x - w - north, cz: z - edge, hx: north, hz: RAIL_HALF, yaw: 0, height: rail },
    { cx: x + w + north, cz: z - edge, hx: north, hz: RAIL_HALF, yaw: 0, height: rail },
    { cx: x - edge, cz: z, hx: RAIL_HALF, hz: d + 2 * RAIL_HALF, yaw: 0, height: rail },
    { cx: x + edge, cz: z, hx: RAIL_HALF, hz: d + 2 * RAIL_HALF, yaw: 0, height: rail },
    { cx: x, cz: z + edge, hx: d + 2 * RAIL_HALF, hz: RAIL_HALF, yaw: 0, height: rail },
  ]
}

/** The walls a click cannot see through at the Faro: the tower (the rails are low and open). */
export const faroWalls = (): Box[] => faroBoxes().slice(0, 4)

/**
 * The games' kiosk: on the islet's sand, toward the pier's head, built from the chiringuito's pieces at a kiosk's
 * size. `angle` and `radius` put its middle (clockwise from straight ahead, as the slots), on the sand between the
 * deck's lit edge and the water; its front faces the hologram, as a chiringuito's does. Where it stands is held by `layout.test.ts`: on the islet, off the pier and its
 * way, clear of the projector, and seen from the spawn beside the hologram, not behind it.
 */
export const KIOSK = { angle: (56 * Math.PI) / 180, radius: 7.1 }
/** All of the kiosk, awning and sign included, in its frame: what must stay on the sand and in sight. */
export const KIOSK_FOOTPRINT = { hx: 1.62, back: -1.0, front: 1.1 }
/** The counter, in the kiosk's frame (+z toward the hologram): what a click or `E` presses. */
export const KIOSK_COUNTER = { x: 0, z: 0.35, hx: 1.15, hz: 0.32, height: 0.85 }
/** The four posts under the awning. */
export const KIOSK_POSTS: ReadonlyArray<Vec2> = [
  { x: -1.25, z: -0.75 },
  { x: 1.25, z: -0.75 },
  { x: -1.25, z: 0.75 },
  { x: 1.25, z: 0.75 },
]

export function kioskPlacement(): Placement {
  const center = { x: Math.sin(KIOSK.angle) * KIOSK.radius, z: -Math.cos(KIOSK.angle) * KIOSK.radius }
  return { slot: -1, center, yaw: Math.atan2(-center.x, -center.z) }
}

/** What stops the character at the kiosk: the counter and the posts. */
export function kioskBoxes(): Box[] {
  const p = kioskPlacement()
  return [
    worldBox(p, KIOSK_COUNTER),
    ...KIOSK_POSTS.map((post) => worldBox(p, { x: post.x, z: post.z, hx: POST_HALF, hz: POST_HALF, height: EAVE_HEIGHT })),
  ]
}

/** Where the counter is pressed: its middle, a little over its top, wide enough to take a click anywhere on it. */
export function kioskSpot(): { x: number; y: number; z: number; radius: number } {
  const p = kioskPlacement()
  const at = toWorld(p, { x: KIOSK_COUNTER.x, z: KIOSK_COUNTER.z })
  return { x: at.x, y: islandHeight(at) + KIOSK_COUNTER.height, z: at.z, radius: 0.9 }
}
