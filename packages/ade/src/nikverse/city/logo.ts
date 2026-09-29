/**
 * The nikcli logo as the hologram in the square is built from it: read from the
 * brand's own SVG, never redrawn.
 *
 * `nikcli-logo-dark.svg` next to this file is a byte-for-byte copy of
 * `packages/console/app/src/asset/brand/nikcli-logo-dark.svg` (a test holds the
 * two to the same hash, so a change to the brand's file that is not copied here
 * fails). Its paths are made only of axis-aligned squares on a 60-unit grid; this
 * reads each subpath as one rectangle and refuses a path that is anything else,
 * so a logo that stops being squares cannot be quietly approximated.
 */

import logoSvg from "./nikcli-logo-dark.svg" with { type: "text" }

/** One square of the logo, in SVG units (y grows downward), with the fill of its path. */
export interface LogoRect {
  x: number
  y: number
  w: number
  h: number
  /** `#RRGGBB`, uppercase, as the file spells it. */
  color: string
}

export interface Logo {
  width: number
  height: number
  rects: LogoRect[]
}

/** The logo the world shows. */
export const LOGO_SVG: string = logoSvg

/**
 * World units per SVG unit. A power of two, so every position and size of the
 * hologram is an exact float and the geometry test can hold it to tolerance 0.
 */
export const LOGO_SCALE = 1 / 64

const TOKEN = /([MmHhVvLlZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g

type Point = [number, number]

/** The rectangle a closed subpath draws, or a refusal. */
function rectangle(points: Point[], color: string): LogoRect {
  const pts = points.length === 5 && points[0][0] === points[4][0] && points[0][1] === points[4][1] ? points.slice(0, 4) : points
  if (pts.length !== 4) throw new Error(`il tracciato non è un rettangolo (${pts.length} vertici)`)
  const xs = [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b)
  const ys = [...new Set(pts.map((p) => p[1]))].sort((a, b) => a - b)
  if (xs.length !== 2 || ys.length !== 2) throw new Error("il tracciato non è un rettangolo con i lati sugli assi")
  // Consecutive vertices share an x or a y, and never both: a square, walked around its sides.
  for (let i = 0; i < 4; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 4]
    if ((a[0] === b[0]) === (a[1] === b[1])) throw new Error("il tracciato non è un rettangolo (lato storto o nullo)")
  }
  return { x: xs[0], y: ys[0], w: xs[1] - xs[0], h: ys[1] - ys[0], color }
}

/** The rectangles of one path's `d`, in the order the path draws them. */
function rectsOfPath(d: string, color: string): LogoRect[] {
  const rects: LogoRect[] = []
  let subpath: Point[] = []
  let at: Point = [0, 0]
  let start: Point = [0, 0]
  let command = ""
  let args: number[] = []
  const arity: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, z: 0 }

  const flush = () => {
    if (!command) return
    const lower = command.toLowerCase()
    const relative = command === lower
    const need = arity[lower]
    if (need === 0) {
      if (args.length) throw new Error("Z con argomenti")
      if (subpath.length) rects.push(rectangle(subpath, color))
      subpath = []
      at = start
    } else {
      if (args.length === 0 || args.length % need !== 0) throw new Error(`argomenti sbagliati per ${command}`)
      for (let i = 0; i < args.length; i += need) {
        const [dx, dy] = lower === "h" ? [args[i], 0] : lower === "v" ? [0, args[i]] : [args[i], args[i + 1]]
        const base: Point = relative ? at : [0, 0]
        const next: Point =
          lower === "h" ? [base[0] + dx, at[1]] : lower === "v" ? [at[0], base[1] + dy] : [base[0] + dx, base[1] + dy]
        if (lower === "m" && i === 0) {
          subpath = [next]
          start = next
        } else subpath.push(next)
        at = next
      }
    }
    args = []
  }

  for (const match of d.matchAll(TOKEN)) {
    if (match[1]) {
      flush()
      command = match[1]
    } else args.push(Number(match[2]))
  }
  flush()
  if (subpath.length) throw new Error("tracciato non chiuso con Z")
  return rects
}

/** Reads the logo's squares out of an SVG made of `<path d fill>`; throws if it is anything else. */
export function parseLogo(svg: string = LOGO_SVG): Logo {
  const box = /viewBox="\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*"/.exec(svg)
  if (!box || Number(box[1]) !== 0 || Number(box[2]) !== 0) throw new Error("viewBox mancante o non da 0 0")
  const rects: LogoRect[] = []
  for (const tag of svg.matchAll(/<path\b[^>]*>/g)) {
    const d = /\sd="([^"]*)"/.exec(tag[0])
    const fill = /\sfill="(#[0-9a-fA-F]{6})"/.exec(tag[0])
    if (!d || !fill) throw new Error("un tracciato senza d o senza fill esadecimale")
    rects.push(...rectsOfPath(d[1], fill[1].toUpperCase()))
  }
  if (rects.length === 0) throw new Error("nessun tracciato")
  return { width: Number(box[3]), height: Number(box[4]), rects }
}

/** One voxel of the hologram: where it stands (centre, y up) and how big it is, in world units. */
export interface Voxel {
  cx: number
  cy: number
  sx: number
  sy: number
  sz: number
  color: string
}

/** How deep a voxel is, as a fraction of its side. */
export const VOXEL_DEPTH = 0.25

/**
 * The voxels of a logo: each square is one, centred on the logo's own centre,
 * turned so y points up. `scale` keeps the arithmetic exact when it is a power of two.
 */
export function logoVoxels(logo: Logo, scale: number = LOGO_SCALE): Voxel[] {
  return logo.rects.map((r) => ({
    cx: (r.x + r.w / 2 - logo.width / 2) * scale,
    cy: (logo.height / 2 - (r.y + r.h / 2)) * scale,
    sx: r.w * scale,
    sy: r.h * scale,
    sz: r.w * scale * VOXEL_DEPTH,
    color: r.color,
  }))
}

/** The square a voxel stands for, back in SVG units: the inverse of `logoVoxels`, for the tests. */
export function voxelRect(logo: Logo, v: Voxel, scale: number = LOGO_SCALE): LogoRect {
  const w = v.sx / scale
  const h = v.sy / scale
  return { x: v.cx / scale + logo.width / 2 - w / 2, y: logo.height / 2 - v.cy / scale - h / 2, w, h, color: v.color }
}
