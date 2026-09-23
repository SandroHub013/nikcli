/**
 * The vial's liquid (S62, DS-S62-5 variant 1 "Fiala, vetro").
 *
 * The Design and Decisions buttons each carry a glass tube whose level says
 * how many items wait. A new one falls in from the top, splashes, and the
 * level rises; an answer lowers it and it sloshes. At rest, with something
 * waiting, the liquid is never quite still: a slow random force on the low
 * modes, like a glass on a desk. With nothing waiting, or with reduced motion,
 * it is still.
 *
 * Ported from the prototype `.ade/design/DS-S62-5/1.html` without changing
 * its constants: the physics is what the user chose by looking at it. Pure,
 * no DOM: the loop (`loop.ts`) steps it and the painter (`paint.ts`) draws it.
 */

export type VialFamily = "design" | "dec"

/** Rest force on the vial's surface; measured to stay well under the gesture. */
export const IDLE_FORCE = 0.11

/** How much liquid for `n` items. Past five it grows no more: the number says the rest. */
export function fill(n: number): number {
  return n <= 0 ? 0 : Math.min(1, 0.28 + 0.18 * (Math.min(n, 5) - 1))
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x)

/** A free surface: waves in a tank between two reflecting walls, at constant volume. */
export class Surface {
  readonly M: number
  readonly h: Float64Array
  readonly v: Float64Array
  private readonly c2: number
  private readonly damp: number

  constructor(points: number, speed: number, damp: number) {
    this.M = points
    this.h = new Float64Array(points)
    this.v = new Float64Array(points)
    this.c2 = speed * speed * (points - 1) * (points - 1)
    this.damp = damp
  }

  step(dt: number): void {
    const { h, v, M } = this
    for (let i = 0; i < M; i++) {
      const l = h[i > 0 ? i - 1 : 1]!
      const r = h[i < M - 1 ? i + 1 : M - 2]!
      v[i]! += (this.c2 * (l + r - 2 * h[i]!) - this.damp * v[i]!) * dt
    }
    let mean = 0
    for (let i = 0; i < M; i++) {
      h[i]! += v[i]! * dt
      mean += h[i]!
    }
    mean /= M
    // A wave does not change the volume.
    for (let i = 0; i < M; i++) h[i]! -= mean
  }

  kick(x: number, amount: number, width: number): void {
    for (let i = 0; i < this.M; i++) {
      const d = (i / (this.M - 1) - x) / width
      this.v[i]! += amount * Math.exp(-d * d)
    }
  }

  at(x: number): number {
    const f = clamp(x, 0, 1) * (this.M - 1)
    const i = Math.min(this.M - 2, f | 0)
    const t = f - i
    return this.h[i]! + (this.h[i + 1]! - this.h[i]!) * t
  }

  energy(): number {
    let e = 0
    for (let i = 0; i < this.M; i++) e += Math.abs(this.v[i]!) + Math.abs(this.h[i]!) * 20
    return e
  }

  flatten(): void {
    this.h.fill(0)
    this.v.fill(0)
  }
}

/*
 * The rest: slow noise with memory (Ornstein-Uhlenbeck). Not a timed
 * animation: a small random force, and the liquid answers with its own
 * physics, at its own frequencies.
 */
class Wander {
  x = 0
  constructor(
    private readonly tau: number,
    private readonly random: () => number,
  ) {}

  step(dt: number): void {
    const g = (this.random() + this.random() + this.random() - 1.5) * 2
    this.x += (-this.x / this.tau) * dt + Math.sqrt((2 * dt) / this.tau) * g
  }
}

export interface VialOptions {
  /** For tests: the rest force's noise. */
  random?: () => number
}

/** One tube. `N` is what waits; `shownN` what the tube shows, which catches up as the drops land. */
export class Vial {
  readonly fam: VialFamily
  N = 0
  shownN = 0
  /** 0 grey, 1 in the button's colour. */
  tone = 0
  /** Seconds left of the gesture: while it lasts the loop runs at full rate. */
  gesture = 0
  dirty = true
  /** Level, its speed and its target, as a fraction of the tube's height. */
  L = 0
  vL = 0
  tL = 0
  drops: { y: number; vy: number }[] = []
  readonly s = new Surface(20, 2.6, 7)
  private readonly w: Wander[]

  constructor(fam: VialFamily, options: VialOptions = {}) {
    this.fam = fam
    const random = options.random ?? Math.random
    this.w = [new Wander(1.6, random), new Wander(2.3, random), new Wander(3.1, random), new Wander(2.7, random)]
  }

  toneTarget(): number {
    return this.N > 0 ? 1 : 0
  }

  /** Alive at rest only with something waiting, and never with reduced motion: "nothing to choose" stays still. */
  idleOn(reduced: boolean): boolean {
    return !reduced && this.N > 0
  }

  /** Where the light gathers inside the liquid, and how it drifts. */
  current(): { x: number; y: number } {
    return { x: clamp(0.5 + 0.26 * this.w[2]!.x, 0.15, 0.85), y: clamp(0.55 + 0.1 * this.w[3]!.x, 0.35, 0.75) }
  }

  /** A new item: a drop falls in from the lip. */
  arrive(reduced: boolean): void {
    this.N++
    if (reduced) return this.snap()
    this.drops.push({ y: -0.15, vy: 0 })
    this.gesture = 2.6
  }

  /** An item answered: the level drops and sloshes. */
  answer(reduced: boolean): void {
    if (this.N === 0) return
    this.N--
    this.shownN = this.N
    this.tL = fill(this.N)
    if (reduced) return this.snap()
    for (let i = 0; i < this.s.M; i++) this.s.v[i]! += 1.1 * (i / (this.s.M - 1) - 0.5)
    this.gesture = 2.2
  }

  /** Straight to `n`, without a gesture. */
  setN(n: number): void {
    this.N = Math.max(0, n)
    this.snap()
  }

  snap(): void {
    this.shownN = this.N
    this.tL = this.L = fill(this.N)
    this.vL = 0
    this.drops = []
    this.s.flatten()
    this.tone = this.toneTarget()
    this.gesture = 0
    this.dirty = true
  }

  step(dt: number, reduced: boolean): void {
    for (const d of this.drops) {
      d.vy += 9 * dt
      d.y += d.vy * dt
    }
    const surf = 1 - this.L
    for (const d of this.drops) {
      if (d.y < surf) continue
      // The impact: a dip, then the waves.
      this.s.kick(0.5, -0.9 * Math.min(1.4, d.vy / 2), 0.12)
      this.shownN = Math.min(this.N, this.shownN + 1)
      this.tL = fill(this.shownN)
    }
    this.drops = this.drops.filter((d) => d.y < surf)
    const a = 80 * (this.tL - this.L) - 8 * this.vL
    this.vL += a * dt
    this.L += this.vL * dt
    if (this.idleOn(reduced)) {
      // At rest the liquid rocks just barely from wall to wall.
      for (const w of this.w) w.step(dt)
      for (let i = 0; i < this.s.M; i++) {
        const x = i / (this.s.M - 1)
        this.s.v[i]! += dt * IDLE_FORCE * (this.w[0]!.x * Math.cos(Math.PI * x) + 0.6 * this.w[1]!.x * Math.cos(2 * Math.PI * x))
      }
    }
    this.s.step(dt)
    this.tone += (this.toneTarget() - this.tone) * Math.min(1, dt * 6)
    this.dirty = true
  }

  /** Still moving after a gesture. Once it is not, it settles exactly: nothing left under the pixel. */
  moving(): boolean {
    const m =
      this.drops.length > 0 ||
      Math.abs(this.vL) > 1e-3 ||
      Math.abs(this.tL - this.L) > 1e-3 ||
      this.s.energy() > 0.02 ||
      Math.abs(this.tone - this.toneTarget()) > 0.01
    if (!m) {
      this.s.flatten()
      this.L = this.tL
      this.tone = this.toneTarget()
    }
    return m
  }
}

/** 2 while a gesture runs (60 fps), 1 at rest with something waiting (about 20), 0 still. */
export function gearOf(vial: Vial, reduced: boolean): 0 | 1 | 2 {
  if (vial.gesture > 0) return 2
  if (vial.idleOn(reduced)) return 1
  return vial.moving() ? 2 : 0
}

/*
 * The tubes, one per family, kept across the button being hidden and shown
 * again: a button that appears because its first item arrived shows that
 * item falling in, not a tube already full.
 */
const vials = new Map<VialFamily, { vial: Vial; seen: boolean }>()

/**
 * The family's tube, told the count now. The first count ever is taken as it
 * is (ADE opening with three proposals waiting is not three arrivals); every
 * later change is a gesture, one per item.
 */
export function vialFor(fam: VialFamily, count: number, reduced: boolean, options?: VialOptions): Vial {
  let entry = vials.get(fam)
  if (!entry) {
    entry = { vial: new Vial(fam, options), seen: false }
    vials.set(fam, entry)
  }
  const { vial } = entry
  if (!entry.seen) {
    entry.seen = true
    vial.setN(count)
    return vial
  }
  while (vial.N < count) vial.arrive(reduced)
  while (vial.N > count) vial.answer(reduced)
  return vial
}

/** For tests: forgets the tubes. */
export function resetVialsForTests(): void {
  vials.clear()
}
