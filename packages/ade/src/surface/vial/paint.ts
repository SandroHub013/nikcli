/**
 * How the vial is drawn (S62, DS-S62-5 variant 1): the same material as the
 * orb, light from the top left, lit per pixel.
 *
 * The glass has a real thickness: full walls, the right side in shade, a long
 * reflection down the left and a thread of light along the round bottom. At
 * the top the lip is wider than the tube — the shape that says "test tube"
 * before the liquid does. The liquid climbs the walls a little: the meniscus
 * of wet glass. Constants from the prototype, unchanged.
 */

import type { ResolvedTheme } from "../../theme"
import type { Vial } from "./sim"

type Rgb = readonly [number, number, number]

export interface Material {
  /** The liquid in each button's colour: `--ade-accent` for Design, `--ade-working` for Decisions. */
  tone: { design: Rgb; dec: Rgb }
  /** The liquid with nothing waiting: grey. */
  neutral: Rgb
  deep: number
  alpha: number
  /** The glass edge, the glass in front of the empty tube, the shaded side, the reflection. */
  wall: string
  body: string
  shade: string
  glint: string
}

export const MATERIAL: Readonly<Record<ResolvedTheme, Material>> = {
  light: { tone: { design: [26, 158, 135], dec: [154, 109, 40] }, neutral: [150, 144, 140], deep: 0.6, alpha: 1, wall: "rgba(26,24,23,.46)", body: "rgba(26,24,23,.05)", shade: "rgba(26,24,23,.18)", glint: "rgba(255,255,255,.95)" },
  dark: { tone: { design: [127, 214, 196], dec: [217, 164, 95] }, neutral: [120, 115, 115], deep: 0.55, alpha: 1, wall: "rgba(236,235,235,.44)", body: "rgba(236,235,235,.06)", shade: "rgba(0,0,0,.35)", glint: "rgba(255,255,255,.55)" },
  glass: { tone: { design: [127, 214, 196], dec: [217, 164, 95] }, neutral: [200, 200, 205], deep: 0.7, alpha: 0.6, wall: "rgba(255,255,255,.58)", body: "rgba(255,255,255,.08)", shade: "rgba(0,0,0,.28)", glint: "rgba(255,255,255,.7)" },
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x)
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** The tube's shape in device pixels, for a canvas `w` × `h` at `dpr`. */
export interface VialGeometry {
  /** One CSS pixel in device pixels. */
  u: number
  lipW: number
  lipH: number
  /** The glass's thickness: always at least one full pixel. */
  wall: number
  /** The inside: left and right edges, top and bottom. */
  x0: number
  x1: number
  top: number
  bottom: number
  /** The round bottom's inner radius. */
  rr: number
}

export function vialGeometry(w: number, h: number, dpr: number): VialGeometry {
  const u = Math.max(1, Math.round(dpr))
  const lipW = Math.max(u, Math.round(w * 0.1))
  const lipH = Math.max(u + 1, Math.round(h * 0.07))
  const wall = Math.max(u, Math.round(Math.min(w, h) * 0.07))
  const x0 = lipW + wall
  const x1 = w - lipW - wall
  const top = lipH + u
  const bottom = h - wall
  return { u, lipW, lipH, wall, x0, x1, top, bottom, rr: (x1 - x0) / 2 }
}

/** How much of pixel (x, y) is inside the tube: 1 in the straight part, fading on the round bottom's edge. */
function insideTube(g: VialGeometry, x: number, y: number): number {
  if (x < g.x0 || x >= g.x1 || y < g.top) return 0
  const cy = g.bottom - g.rr
  if (y + 0.5 <= cy) return 1
  const dx = x + 0.5 - (g.x0 + g.rr)
  const dy = y + 0.5 - cy
  return clamp(g.rr - Math.hypot(dx, dy) + 0.5, 0, 1)
}

/**
 * The liquid, per pixel, into `data` (RGBA, `w` wide): seen from the side
 * under its surface, darker towards the bottom, a line of light on the
 * surface, and the light gathered inside where the current carries it.
 */
export function shadeLiquid(data: Uint8ClampedArray, w: number, h: number, dpr: number, vial: Vial, theme: ResolvedTheme): void {
  const m = MATERIAL[theme]
  const g = vialGeometry(w, h, dpr)
  const { x0, x1, top, bottom, u } = g
  const innerH = bottom - top
  const body = mix(m.neutral, m.tone[vial.fam], vial.tone)
  const level = bottom - vial.L * innerH
  const menW = Math.max(1, (x1 - x0) * 0.16)
  const menH = vial.L > 0.02 ? Math.min(1.2 * u, innerH * 0.06) : 0
  const menisc = (x: number) => -menH * (Math.exp(-(x + 0.5 - x0) / menW) + Math.exp(-(x1 - x - 0.5) / menW))
  const cur = vial.current()
  const caus = { x: x0 + (x1 - x0) * cur.x, y: level + (bottom - level) * cur.y, rx: (x1 - x0) * 0.32, ry: Math.max(1, (bottom - level) * 0.28), k: vial.tone }
  const surfAt = (x: number) => vial.s.at((x + 0.5 - x0) / (x1 - x0))
  const k = m.deep
  for (let x = x0; x < x1; x++) {
    const ys = level + menisc(x) + surfAt(x) * innerH
    const slope = (vial.s.at((x + 1.5 - x0) / (x1 - x0)) - vial.s.at((x - 0.5 - x0) / (x1 - x0))) * innerH + (menisc(x + 1) - menisc(x - 1)) / 2
    const lit = clamp(0.55 - slope * 0.9, 0.2, 1)
    for (let y = Math.max(top, Math.floor(ys - 1)); y < bottom; y++) {
      const cov = insideTube(g, x, y)
      if (cov <= 0) continue
      const s = y + 0.5 - ys
      if (s < -0.5) continue
      const a1 = clamp(s + 0.5, 0, 1) * cov
      const depth = clamp(s / Math.max(1, bottom - ys), 0, 1)
      const f = 1 - (1 - k) * (0.1 + 0.6 * depth)
      let sp = Math.exp(-(s * s) / 1.1) * lit
      const qx = (x + 0.5 - caus.x) / caus.rx
      const qy = (y + 0.5 - caus.y) / caus.ry
      sp = Math.min(1, sp + 0.45 * caus.k * Math.exp(-qx * qx - qy * qy))
      const o = (y * w + x) * 4
      const c0 = body[0] * f
      const c1 = body[1] * f
      const c2 = body[2] * f
      data[o] = c0 + (255 - c0) * sp
      data[o + 1] = c1 + (255 - c1) * sp
      data[o + 2] = c2 + (255 - c2) * sp
      data[o + 3] = 255 * a1 * Math.min(1, m.alpha + (1 - m.alpha) * (sp * 1.5 + depth * 0.4))
    }
  }
}

/** The falling drops and the glass, over the liquid. */
export function drawGlass(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, vial: Vial, theme: ResolvedTheme): void {
  const m = MATERIAL[theme]
  const g = vialGeometry(w, h, dpr)
  const { u, lipW, lipH, wall, x0, x1, top, bottom, rr } = g
  const innerH = bottom - top
  const body = mix(m.neutral, m.tone[vial.fam], vial.tone)
  for (const drop of vial.drops) {
    const y = top + drop.y * innerH
    const r = Math.max(1, (x1 - x0) * 0.2)
    ctx.beginPath()
    ctx.ellipse((x0 + x1) / 2, y, r, r * 1.25, 0, 0, 7)
    ctx.fillStyle = `rgb(${body.map(Math.round).join(",")})`
    ctx.fill()
  }
  // The glass: the full profile (the walls have a thickness), then the glass in front and the lights.
  const cx = (x0 + x1) / 2
  const ro = rr + wall
  const tube = new Path2D()
  tube.moveTo(x0 - wall, top)
  tube.lineTo(x0 - wall, bottom - rr)
  tube.arc(cx, bottom - rr, ro, Math.PI, 0, true)
  tube.lineTo(x1 + wall, top)
  tube.lineTo(x1, top)
  tube.lineTo(x1, bottom - rr)
  tube.arc(cx, bottom - rr, rr, 0, Math.PI, false)
  tube.lineTo(x0, top)
  tube.closePath()
  ctx.fillStyle = m.wall
  ctx.fill(tube)
  ctx.fillStyle = m.body
  ctx.fillRect(x0, top, x1 - x0, bottom - rr - top)
  // The lip: a ring wider than the tube, with the light on its top edge.
  const lip = new Path2D()
  lip.roundRect(lipW - Math.max(0, u - 1), 0, w - 2 * lipW + 2 * Math.max(0, u - 1), lipH, Math.min(lipH / 2, 2 * u))
  ctx.fillStyle = m.wall
  ctx.fill(lip)
  ctx.fillStyle = m.glint
  ctx.fillRect(lipW + u, 0, Math.max(u, (w - 2 * lipW) * 0.45), Math.max(1, Math.round(u * 0.8)))
  // The shaded side: the right wall is darker, so the tube has a volume even at 20 px.
  ctx.fillStyle = m.shade
  ctx.fillRect(x1, top, wall, bottom - rr - top)
  // The long reflection: a strip on the left, fading at both ends, like a window on the glass.
  const gx = x0 + Math.max(u * 0.6, (x1 - x0) * 0.14)
  const gw = Math.max(u * 0.9, (x1 - x0) * 0.13)
  const gy0 = top + innerH * 0.06
  const gy1 = bottom - rr * 0.9
  const gradient = ctx.createLinearGradient(0, gy0, 0, gy1)
  gradient.addColorStop(0, "rgba(255,255,255,0)")
  gradient.addColorStop(0.18, m.glint)
  gradient.addColorStop(0.7, m.glint)
  gradient.addColorStop(1, "rgba(255,255,255,0)")
  ctx.fillStyle = gradient
  ctx.fillRect(gx, gy0, gw, gy1 - gy0)
  // The light on the round bottom, low on the left: it says "curved" even when the tube is full.
  ctx.strokeStyle = m.glint
  ctx.lineWidth = Math.max(0.8, u * 0.7)
  ctx.beginPath()
  ctx.arc(cx, bottom - rr, Math.max(1, rr - wall * 0.2 - u * 0.8), Math.PI * 0.62, Math.PI * 0.86)
  ctx.stroke()
}
