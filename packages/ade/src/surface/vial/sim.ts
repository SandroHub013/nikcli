/**
 * The vial's liquid (S62, DS-S62-5 variant 1 "Fiala, vetro").
 *
 * The Design and Decisions buttons each carry a glass tube whose level says
 * how many items wait. A new one falls in from the top, splashes, and the
 * level rises; an answer lowers it and it sloshes. Between changes it is a
 * still picture.
 *
 * Ported from the prototype `.ade/design/DS-S62-5/1.html` without changing
 * the gesture's constants: the physics is what the user chose by looking at
 * it. The prototype's rest motion — a slow random force on the low modes
 * whenever something waited — is gone: measured in ADE it cost 5 points of a
 * core, GPU included, for as long as anything waited, which is almost always
 * (Verifiche, 2026-09-24). Pure, no DOM: the loop (`loop.ts`) steps it and the
 * painter (`paint.ts`) draws it.
 */

export type VialFamily = "design" | "dec"

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

  constructor(fam: VialFamily) {
    this.fam = fam
  }

  toneTarget(): number {
    return this.N > 0 ? 1 : 0
  }

  /** Where the light gathers inside the liquid: where the prototype's drift was centred. */
  current(): { x: number; y: number } {
    return { x: 0.5, y: 0.55 }
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

  step(dt: number): void {
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
      // The last frame paints this exact level.
      this.dirty = true
    }
    return m
  }
}

/** Whether it needs frames: during a gesture and until it has settled. At rest, with anything waiting or not, it does not. */
export function animating(vial: Vial): boolean {
  return vial.gesture > 0 || vial.moving()
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
export function vialFor(fam: VialFamily, count: number, reduced: boolean): Vial {
  let entry = vials.get(fam)
  if (!entry) {
    entry = { vial: new Vial(fam), seen: false }
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
