import { describe, expect, test } from "bun:test"
import { blocked, moveWithCollisions, pushOut } from "./collision"
import { BODY_RADIUS } from "./controller"
import { BACK_BAR, COUNTER, MOUTH, placementOf, shopBoxes, toLocal, toWorld, wallsLocal, type Vec2 } from "./layout"

const SLOT = 2
const placement = placementOf(SLOT)
const world = { boxes: shopBoxes(placement, 4), radius: 200 }
const R = BODY_RADIUS

/** How many of a shop's boxes are its fixed pieces; the tables come after. */
const FIXED = wallsLocal().length
/** Behind the counter, in the shop's frame: between it and the back bar, and not past its ends. */
const BEHIND_X = COUNTER.hx - 0.2
const behindLocal = (p: Vec2) =>
  Math.abs(p.x) < BEHIND_X && p.z < COUNTER.z - COUNTER.hz && p.z > BACK_BAR.z + BACK_BAR.hz

/** A repeatable stream of numbers in 0..1. */
function random(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

describe("the character does not stand in a wall", () => {
  test("a circle inside a piece of the chiringuito is pushed out to at least its radius, on the side it was nearest to", () => {
    for (const wall of world.boxes.slice(0, FIXED)) {
      const out = pushOut({ x: wall.cx, z: wall.cz }, R, wall)
      const back = toLocal({ ...placement, center: { x: wall.cx, z: wall.cz } }, out)
      expect(Math.hypot(back.x, back.z)).toBeGreaterThanOrEqual(R - 1e-9)
    }
    // A circle clear of every box is returned as it is.
    const far = { x: 500, z: 500 }
    for (const box of world.boxes) expect(pushOut(far, R, box)).toBe(far)
  })

  test("running straight at the counter from the front, or at the back bar from behind, at any frame rate, never gets through", () => {
    const counterFront = COUNTER.z + COUNTER.hz
    const barBack = BACK_BAR.z - BACK_BAR.hz
    const runs = [
      // Between the loungers and past the tables' side, straight at the counter.
      { from: { x: 1.15, z: 9 }, to: { x: 1.15, z: -1 }, stays: (l: Vec2) => l.z >= counterFront + R - 1e-6 },
      { from: { x: -1.15, z: 9 }, to: { x: -1.15, z: -1 }, stays: (l: Vec2) => l.z >= counterFront + R - 1e-6 },
      { from: { x: 0, z: -9 }, to: { x: 0, z: 0 }, stays: (l: Vec2) => l.z <= barBack - R + 1e-6 },
      { from: { x: -2, z: -9 }, to: { x: -2, z: 0 }, stays: (l: Vec2) => l.z <= barBack - R + 1e-6 },
    ]
    for (const { from, to, stays } of runs) {
      for (const speed of [3.2, 6.4, 40, 200]) {
        for (const dt of [1 / 240, 1 / 60, 0.1]) {
          let at = toWorld(placement, from)
          const goal = toWorld(placement, to)
          const dir = { x: goal.x - at.x, z: goal.z - at.z }
          const len = Math.hypot(dir.x, dir.z)
          for (let step = 0; step < 400; step++) {
            at = moveWithCollisions(at, { x: (dir.x / len) * speed * dt, z: (dir.z / len) * speed * dt }, R, world)
            expect([from, speed, dt, blocked(at, R - 1e-6, world)]).toEqual([from, speed, dt, false])
            expect([from, speed, dt, stays(toLocal(placement, at))]).toEqual([from, speed, dt, true])
          }
        }
      }
    }
  })

  test("from every side, at random, the only way behind the counter is round one of its ends", () => {
    const next = random(7)
    let entered = 0
    for (let trial = 0; trial < 300; trial++) {
      let at = toWorld(placement, { x: (next() - 0.5) * 16, z: (next() - 0.5) * 16 })
      if (behindLocal(toLocal(placement, at)) || blocked(at, R, world)) continue
      let heading = next() * Math.PI * 2
      for (let step = 0; step < 300; step++) {
        if (next() < 0.05) heading += (next() - 0.5) * 2
        const speed = 3 + next() * 40
        // A frame's move in pieces no longer than the collision's own steps: at 40 m/s a frame is 0.7 m, and where the
        // centre is at the end of it says little about where it came in.
        const move = { x: (Math.sin(heading) * speed) / 60, z: (Math.cos(heading) * speed) / 60 }
        const pieces = Math.ceil(Math.hypot(move.x, move.z) / 0.15)
        for (let k = 0; k < pieces; k++) {
          const was = toLocal(placement, at)
          at = moveWithCollisions(at, { x: move.x / pieces, z: move.z / pieces }, R, world)
          expect(blocked(at, R - 1e-6, world)).toBe(false)
          if (!behindLocal(was) && behindLocal(toLocal(placement, at))) {
            entered++
            // Coming in, the centre was beside the counter, not in front of it or past the back bar.
            expect(Math.abs(was.x)).toBeGreaterThanOrEqual(BEHIND_X)
          }
        }
      }
    }
    // The walk is random, so it must have got behind the counter at least once for this to mean something.
    expect(entered).toBeGreaterThan(0)
  })

  test("round the end of the counter there is room to walk behind it, between the tables and the posts", () => {
    let at = toWorld(placement, { x: 1.15, z: 3 })
    for (const stop of [
      { x: 1.15, z: 1 },
      { x: 2.25, z: 1 },
      { x: 2.25, z: -1.2 },
      { x: 0, z: -1.2 },
    ]) {
      const goal = toWorld(placement, stop)
      for (let step = 0; step < 200; step++) {
        const dir = { x: goal.x - at.x, z: goal.z - at.z }
        const len = Math.hypot(dir.x, dir.z)
        if (len < 0.05) break
        const d = Math.min(0.1, len)
        at = moveWithCollisions(at, { x: (dir.x / len) * d, z: (dir.z / len) * d }, R, world)
      }
      const local = toLocal(placement, at)
      expect([stop, Math.hypot(local.x - stop.x, local.z - stop.z) < 0.1]).toEqual([stop, true])
    }
    expect(behindLocal(toLocal(placement, at))).toBe(true)
  })

  test("walking into the back bar at a slant slides along it: the part of the move along it is kept", () => {
    const from = { x: -2, z: BACK_BAR.z - BACK_BAR.hz - R - 0.02 }
    const start = toWorld(placement, from)
    const goal = toWorld(placement, { x: from.x + 3, z: from.z + 1 })
    const end = moveWithCollisions(start, { x: goal.x - start.x, z: goal.z - start.z }, R, world)
    const b = toLocal(placement, end)
    expect(b.x - from.x).toBeGreaterThan(2.5)
    expect(b.z).toBeLessThan(BACK_BAR.z - BACK_BAR.hz)
    expect(blocked(end, R - 1e-6, world)).toBe(false)
  })

  test("a table is an obstacle too", () => {
    const table = world.boxes[FIXED]
    const from = { x: table.cx, z: table.cz }
    const out = moveWithCollisions(from, { x: 0, z: 0 }, R, world)
    expect(blocked(out, R - 1e-6, world)).toBe(false)
  })
})

describe("the edge of the ground", () => {
  test("walking outward stops at the edge, by the character's own radius", () => {
    const edge = { boxes: [], radius: 50 }
    let at = { x: 0, z: 0 }
    for (let i = 0; i < 100; i++) at = moveWithCollisions(at, { x: 1, z: 0 }, R, edge)
    expect(Math.hypot(at.x, at.z)).toBeCloseTo(50 - R, 9)
    for (let i = 0; i < 100; i++) at = moveWithCollisions(at, { x: 0, z: 300 }, R, edge)
    expect(Math.hypot(at.x, at.z)).toBeLessThanOrEqual(50 - R + 1e-9)
  })
})

describe("the lagoon's mouth", () => {
  const island = { boxes: [], radius: 33, mouth: MOUTH }
  const inMouth = (p: Vec2) => Math.hypot(p.x, p.z) > MOUTH.radius && Math.PI - Math.abs(Math.atan2(p.x, -p.z)) < MOUTH.halfAngle

  test("walking south from the islet stops at the mouth's edge, in the lagoon", () => {
    let at: Vec2 = { x: 0, z: 5 }
    for (let i = 0; i < 400; i++) at = moveWithCollisions(at, { x: 0, z: 0.1 }, R, island)
    expect(Math.hypot(at.x, at.z)).toBeCloseTo(MOUTH.radius - R, 6)
  })

  test("from every direction, at random, nobody ends up in the mouth, and the beach either side of it is walkable", () => {
    const next = random(11)
    for (let trial = 0; trial < 200; trial++) {
      let at: Vec2 = { x: (next() - 0.5) * 30, z: (next() - 0.5) * 30 }
      const heading = next() * Math.PI * 2
      for (let step = 0; step < 100; step++) {
        at = moveWithCollisions(at, { x: Math.sin(heading) * 0.3, z: Math.cos(heading) * 0.3 }, R, island)
        expect([trial, step, inMouth(at)]).toEqual([trial, step, false])
      }
    }
    // Just outside the mouth's edge, on the beach, a body stands where it is.
    const a = MOUTH.halfAngle + 0.2
    const beach = { x: Math.sin(Math.PI - a) * 25, z: -Math.cos(Math.PI - a) * 25 }
    expect(moveWithCollisions(beach, { x: 0, z: 0 }, R, island)).toEqual(beach)
  })
})
