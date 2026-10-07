import { describe, expect, test } from "bun:test"
import type { BufferGeometry, Mesh, Object3D } from "three/webgpu"
import { blocked, moveWithCollisions, type World } from "./collision"
import { BODY_RADIUS, spawnPlayer } from "./controller"
import { CONE_RADIUS } from "./hologram"
import type { Ray } from "./interaction"
import {
  FARO,
  FARO_DOOR,
  FARO_WALK,
  KIOSK_FOOTPRINT,
  MOUTH,
  PIER,
  PLATFORM_RADIUS,
  RING_SLOTS,
  faroBoxes,
  inBox,
  islandHeight,
  kioskBoxes,
  kioskPlacement,
  onWalkway,
  placementOf,
  shopBoxes,
  toWorld,
  WALKWAYS,
  type Box,
  type Vec2,
} from "./layout"
import { createPlaces, faroGeometry, HALO_SIZE, SIGN_SIZE } from "./places-view"
import { placeBoxes } from "./places"
import { kitFor } from "./test-cast"

/** The projector under the hologram, as `main.ts` has it. */
const PROJECTOR: Box = { cx: 0, cz: 0, hx: 3.1, hz: 3.1, yaw: 0, height: 0.62 }
/** The islet's dry sand ends here (`ISLAND_PROFILE`). */
const ISLET_SAND = 8.3
const R = BODY_RADIUS
/** The island as the character walks it, with the two places and no shop. */
const island: World = { boxes: [PROJECTOR, ...placeBoxes()], radius: 33, mouth: MOUTH, walkways: WALKWAYS }

const radius = (p: Vec2) => Math.hypot(p.x, p.z)
const inMouth = (p: Vec2) => radius(p) > MOUTH.radius && Math.PI - Math.abs(Math.atan2(p.x, -p.z)) < MOUTH.halfAngle
/** The kiosk's corners in the world, awning and sign included. */
const kioskCorners = (): Vec2[] => {
  const p = kioskPlacement()
  const { hx, back, front } = KIOSK_FOOTPRINT
  return [toWorld(p, { x: -hx, z: back }), toWorld(p, { x: hx, z: back }), toWorld(p, { x: -hx, z: front }), toWorld(p, { x: hx, z: front })]
}
const boxCorners = (b: Box): Vec2[] => {
  const s = Math.sin(b.yaw)
  const c = Math.cos(b.yaw)
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([i, k]) => ({ x: b.cx + i * b.hx * c + k * b.hz * s, z: b.cz - i * b.hx * s + k * b.hz * c }))
}
/** Two boxes overlap (separating axes, in the plane). */
function overlap(a: Box, b: Box, margin = 0): boolean {
  const grow = (x: Box): Box => ({ ...x, hx: x.hx + margin, hz: x.hz + margin })
  const [p, q] = [grow(a), grow(b)]
  for (const box of [p, q]) {
    for (const yaw of [box.yaw, box.yaw + Math.PI / 2]) {
      const axis = { x: Math.cos(yaw), z: -Math.sin(yaw) }
      const span = (x: Box) => boxCorners(x).map((c) => c.x * axis.x + c.z * axis.z)
      const [sp, sq] = [span(p), span(q)]
      if (Math.max(...sp) < Math.min(...sq) || Math.max(...sq) < Math.min(...sp)) return false
    }
  }
  return true
}
/** A ray from `from` at `to`. */
function through(from: [number, number, number], to: [number, number, number]): Ray {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
  const len = Math.hypot(d[0], d[1], d[2])
  return { ox: from[0], oy: from[1], oz: from[2], dx: d[0] / len, dy: d[1] / len, dz: d[2] / len }
}
/** Walks in a straight line toward `to`, `steps` frames of 0.1 m. */
function walk(from: Vec2, to: Vec2, world: World, steps = 400, each?: (at: Vec2) => void): Vec2 {
  let at = from
  for (let i = 0; i < steps; i++) {
    const d = Math.hypot(to.x - at.x, to.z - at.z)
    if (d < 0.05) break
    const step = Math.min(0.1, d)
    at = moveWithCollisions(at, { x: ((to.x - at.x) / d) * step, z: ((to.z - at.z) / d) * step }, R, world)
    each?.(at)
  }
  return at
}
/** A repeatable stream of numbers in 0..1. */
function random(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

describe("where the games' kiosk stands", () => {
  test("all of it is on the islet's sand: past the deck's lit edge, short of the water", () => {
    for (const c of kioskCorners()) {
      expect(radius(c)).toBeLessThanOrEqual(ISLET_SAND)
      expect(radius(c)).toBeGreaterThan(PLATFORM_RADIUS)
    }
    for (const b of kioskBoxes()) for (const c of boxCorners(b)) expect(radius(c)).toBeLessThanOrEqual(ISLET_SAND)
  })

  test("it keeps off the pier and its way: a metre clear either side of it, and the islet to the pier is walkable", () => {
    for (const c of kioskCorners()) expect(Math.abs(c.x)).toBeGreaterThan(PIER.halfWidth + 1)
    // From the north of the projector straight onto the pier and to its end on the beach.
    const end = walk({ x: 0, z: -3.6 }, { x: 0, z: PIER.fromZ + 0.5 }, island)
    expect(end.z).toBeCloseTo(PIER.fromZ + 0.5, 1)
  })

  test("a body passes between it and the projector", () => {
    for (const b of kioskBoxes()) expect(overlap(b, PROJECTOR, 2 * R)).toBe(false)
  })

  test("from the spawn it is seen beside the hologram, not behind it: every corner is outside the hologram's cone", () => {
    const spawn = spawnPlayer()
    const toHologram = Math.atan2(0 - spawn.x, 0 - spawn.z)
    const cone = Math.atan(CONE_RADIUS / radius(spawn))
    for (const c of kioskCorners()) {
      const angle = Math.atan2(c.x - spawn.x, c.z - spawn.z)
      expect(Math.abs(angle - toHologram)).toBeGreaterThan(cone)
    }
  })

  test("its front faces the hologram, as a chiringuito's does", () => {
    const p = kioskPlacement()
    const front = toWorld(p, { x: 0, z: 1 })
    expect(radius(front)).toBeLessThan(radius(p.center))
  })
})

describe("where the Faro stands", () => {
  test("its rock and deck are in the lagoon's mouth, past the last pair of chiringuiti, and touch no shop of any ring", () => {
    const deck = WALKWAYS[1]
    for (const c of boxCorners(deck)) expect(inMouth(c)).toBe(true)
    for (let slot = 0; slot < RING_SLOTS * 2; slot++)
      for (const shop of shopBoxes(placementOf(slot), 4)) for (const w of WALKWAYS) expect([slot, overlap(shop, w, 1)]).toEqual([slot, false])
  })

  test("from the north shore it stands beside the hologram, against the south's glow, and over the horizon", () => {
    const shore = { x: 0, z: PIER.fromZ }
    const cone = Math.atan(CONE_RADIUS / radius(shore))
    // The tower's near edge, seen from the shore, is outside the hologram's cone.
    const toFaro = Math.atan2(FARO.x - shore.x, FARO.z - shore.z)
    const half = Math.atan(FARO.towerRadius / Math.hypot(FARO.x - shore.x, FARO.z - shore.z))
    expect(Math.abs(toFaro) - half).toBeGreaterThan(cone)
    // South of the shore, in the glow's quarter.
    expect(Math.abs(toFaro)).toBeLessThan(Math.PI / 4)
    expect(FARO.towerTop).toBeGreaterThan(10)
  })

  test("the boardwalk starts on the islet's sand and ends at the deck; its ground is its deck, and the ground never jumps", () => {
    expect(radius({ x: FARO.x, z: FARO_WALK.fromZ })).toBeLessThan(ISLET_SAND)
    expect(FARO_WALK.toZ).toBe(WALKWAYS[1].cz - WALKWAYS[1].hz)
    let last = islandHeight({ x: FARO.x, z: FARO_WALK.fromZ - 0.5 })
    for (let z = FARO_WALK.fromZ - 0.5; z < FARO_DOOR.z; z += 0.05) {
      const h = islandHeight({ x: FARO.x, z })
      if (z >= FARO_WALK.fromZ) expect(h).toBe(FARO.top)
      expect(Math.abs(h - last)).toBeLessThanOrEqual(0.1)
      last = h
    }
  })

  test("the rails start before the mouth does, under the boardwalk", () => {
    for (const side of [-1, 1]) expect(inMouth({ x: FARO.x + side * FARO_WALK.halfWidth, z: FARO_WALK.railsFromZ })).toBe(false)
  })
})

describe("walking to the Faro", () => {
  test("from the islet along the boardwalk to the door, within reach of it, and the boardwalk is never left in the mouth", () => {
    const start = { x: FARO.x, z: FARO_WALK.fromZ + 0.3 }
    const end = walk(start, { x: FARO_DOOR.x, z: FARO_DOOR.z }, island, 400, (at) => {
      if (inMouth(at)) expect(onWalkway(at)).toBeDefined()
    })
    expect(Math.hypot(end.x - FARO_DOOR.x, end.z - FARO_DOOR.z)).toBeLessThanOrEqual(0.6)
  })

  test("round the tower on the deck, all the way, with no wall where nothing is drawn", () => {
    const corners = [
      { x: FARO.x - 2, z: FARO.z - 2 },
      { x: FARO.x + 2, z: FARO.z - 2 },
      { x: FARO.x + 2, z: FARO.z + 2 },
      { x: FARO.x - 2, z: FARO.z + 2 },
    ]
    let at = walk({ x: FARO.x, z: FARO_WALK.toZ - 0.5 }, corners[0], island)
    for (const c of [...corners.slice(1), corners[0]]) {
      at = walk(at, c, island)
      expect(Math.hypot(at.x - c.x, at.z - c.z)).toBeLessThan(0.1)
    }
  })

  test("at random, on the boardwalk and the deck, nobody leaves the planks where the mouth is, and nobody else enters it", () => {
    const next = random(24)
    for (let trial = 0; trial < 120; trial++) {
      // Half the trials start on the planks, half anywhere around the lagoon.
      let at: Vec2 =
        trial % 2 === 0
          ? { x: FARO.x + (next() - 0.5) * 1.2, z: FARO_WALK.fromZ + next() * (FARO.z + 2 - FARO_WALK.fromZ) }
          : { x: (next() - 0.5) * 34, z: (next() - 0.5) * 34 }
      at = moveWithCollisions(at, { x: 0, z: 0 }, R, island)
      const heading = next() * Math.PI * 2
      for (let step = 0; step < 120; step++) {
        at = moveWithCollisions(at, { x: Math.sin(heading) * 0.3, z: Math.cos(heading) * 0.3 }, R, island)
        expect([trial, step, !inMouth(at) || onWalkway(at) !== undefined]).toEqual([trial, step, true])
      }
    }
  })

  test("every box that stops the character at the Faro is drawn: rails and tower are where the mesh is", () => {
    const geometry = faroGeometry()
    const pos = geometry.getAttribute("position")
    const drawnIn = (b: Box) => {
      for (let i = 0; i < pos.count; i++) if (inBox({ x: pos.getX(i), z: pos.getZ(i) }, b, 0.02) && pos.getY(i) > FARO.top + 0.2) return true
      return false
    }
    for (const b of faroBoxes()) expect(drawnIn(b)).toBe(true)
    // The tower's boxes stay within 10 cm of the drawn tower's foot.
    for (const b of faroBoxes().slice(0, 4)) for (const c of boxCorners(b)) expect(Math.hypot(c.x - FARO.x, c.z - FARO.z)).toBeLessThanOrEqual(FARO.towerRadius + 0.1)
  })
})

