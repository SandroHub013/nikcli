/**
 * The two places where one learns, as three.js objects: the Faro on its rock with its boardwalk, and the games'
 * kiosk on the islet.
 *
 * The Faro is made here, not in `city.glb`: one geometry of boxes and cylinders whose light is painted into its
 * vertex colours, as the generator bakes the island's (the dusk's glow low in the south, the sky above, a violet
 * shade on the north faces), drawn with one unlit material in one draw call. Its lantern and the lamp over its door
 * are colours that do not take the shade: a static glow, nothing turns and nothing blinks. A soft halo round the
 * lantern is one sprite.
 *
 * The kiosk is the chiringuito's own pieces at a kiosk's size (`CityKit.piece`): a counter, the striped awning, a
 * sign, and four posts cut out of the fixtures. They share the shops' geometry and material; what is new is the
 * posts' few triangles, the awning's colour and the sign's word. Without the file it is a few plain boxes.
 *
 * Nothing here moves or changes after it is built: the places add no reason for the loop to draw.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  type Material,
} from "three/webgpu"
import type { CityKit } from "./kit"
import {
  EAVE_HEIGHT,
  FARO,
  FARO_DOOR,
  FARO_WALK,
  KIOSK_COUNTER,
  KIOSK_POSTS,
  RAIL_HALF,
  RAIL_HEIGHT,
  faroBoxes,
  islandHeight,
  kioskPlacement,
  type Box,
} from "./layout"
import { kioskSign, type WorldLang } from "./places"

type V3 = [number, number, number]

/** Where the light comes from: the glow of the sun that set to the south, low over the mouth (`water.ts`). */
const GLOW: V3 = (() => {
  const v: V3 = [0, 0.35, 1]
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
})()
/** The shade's colour: the north faces are in the dusk's violet. */
const SHADE: V3 = [0.9, 0.88, 1]

/** A colour as three.js works it (linear), lit from `normal`, or as it is when it glows. */
function painted(hex: number, normal: V3, glows: boolean): V3 {
  const c = new Color(hex)
  if (glows) return [c.r, c.g, c.b]
  const toward = Math.max(0, normal[0] * GLOW[0] + normal[1] * GLOW[1] + normal[2] * GLOW[2])
  const light = 0.4 + 0.42 * toward + 0.2 * Math.max(0, normal[1])
  return [Math.min(1, c.r * light * SHADE[0]), Math.min(1, c.g * light * SHADE[1]), Math.min(1, c.b * light * SHADE[2])]
}

/** Triangles with their colours, gathered into one geometry. */
class Painter {
  readonly position: number[] = []
  readonly color: number[] = []

  /** A flat face, turned so that its front is `normal`'s side whatever order the corners come in. */
  face(corners: V3[], normal: V3, hex: number, glows = false): void {
    const [a, b, c] = corners
    const cross: V3 = [
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    ]
    const ordered = cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2] < 0 ? [...corners].reverse() : corners
    const rgb = painted(hex, normal, glows)
    for (let i = 1; i + 1 < ordered.length; i++) {
      for (const p of [ordered[0], ordered[i], ordered[i + 1]]) {
        this.position.push(p[0], p[1], p[2])
        this.color.push(rgb[0], rgb[1], rgb[2])
      }
    }
  }

  /** A box: its middle, its half sizes, its turn about y. */
  box(c: V3, h: V3, hex: number, yaw = 0, glows = false): void {
    const s = Math.sin(yaw)
    const k = Math.cos(yaw)
    const at = (x: number, y: number, z: number): V3 => [c[0] + x * k + z * s, c[1] + y, c[2] - x * s + z * k]
    const turn = (n: V3): V3 => [n[0] * k + n[2] * s, n[1], -n[0] * s + n[2] * k]
    const [x, y, z] = h
    this.face([at(-x, y, -z), at(x, y, -z), at(x, y, z), at(-x, y, z)], [0, 1, 0], hex, glows)
    this.face([at(-x, -y, -z), at(x, -y, -z), at(x, -y, z), at(-x, -y, z)], [0, -1, 0], hex, glows)
    this.face([at(x, -y, -z), at(x, y, -z), at(x, y, z), at(x, -y, z)], turn([1, 0, 0]), hex, glows)
    this.face([at(-x, -y, -z), at(-x, y, -z), at(-x, y, z), at(-x, -y, z)], turn([-1, 0, 0]), hex, glows)
    this.face([at(-x, -y, z), at(x, -y, z), at(x, y, z), at(-x, y, z)], turn([0, 0, 1]), hex, glows)
    this.face([at(-x, -y, -z), at(x, -y, -z), at(x, y, -z), at(-x, y, -z)], turn([0, 0, -1]), hex, glows)
  }

  /** A round band from `y0` to `y1`, `r0` at the foot and `r1` at the top, with its top closed when `cap`. */
  band(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, segments: number, hex: number, cap = false, glows = false): void {
    const at = (r: number, a: number, y: number): V3 => [cx + Math.sin(a) * r, y, cz - Math.cos(a) * r]
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2
      const a1 = ((i + 1) / segments) * Math.PI * 2
      const mid = (a0 + a1) / 2
      const slope = (r0 - r1) / Math.max(1e-6, y1 - y0)
      const n: V3 = [Math.sin(mid), slope, -Math.cos(mid)]
      const l = Math.hypot(...n)
      const corners = r1 > 1e-6 ? [at(r0, a0, y0), at(r0, a1, y0), at(r1, a1, y1), at(r1, a0, y1)] : [at(r0, a0, y0), at(r0, a1, y0), at(0, 0, y1)]
      this.face(corners, [n[0] / l, n[1] / l, n[2] / l], hex, glows)
      if (cap && r1 > 1e-6) this.face([[cx, y1, cz], at(r1, a0, y1), at(r1, a1, y1)], [0, 1, 0], hex, glows)
    }
  }

  /** A rough stone: an icosahedron, its points pushed in and out, flattened a little. */
  boulder(c: V3, size: number, hex: number, next: () => number): void {
    const t = (1 + Math.sqrt(5)) / 2
    const base: V3[] = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ]
    const points = base.map((v): V3 => {
      const l = Math.hypot(...v)
      const k = (size / l) * (0.75 + next() * 0.5)
      return [c[0] + v[0] * k, c[1] + v[1] * k * 0.7, c[2] + v[2] * k]
    })
    const faces = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ]
    for (const [a, b, e] of faces) {
      const mid: V3 = [(points[a][0] + points[b][0] + points[e][0]) / 3 - c[0], (points[a][1] + points[b][1] + points[e][1]) / 3 - c[1], (points[a][2] + points[b][2] + points[e][2]) / 3 - c[2]]
      const l = Math.hypot(...mid) || 1
      this.face([points[a], points[b], points[e]], [mid[0] / l, mid[1] / l, mid[2] / l], hex)
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry()
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.position), 3))
    g.setAttribute("color", new BufferAttribute(new Float32Array(this.color), 3))
    g.computeBoundingSphere()
    return g
  }
}

/** A repeatable stream of numbers in 0..1: the rock and the planks look the same at every opening. */
function random(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

const WOOD = 0x8a6a4c
const WOOD_DARK = 0x5b4532
const ROCK = 0x5f5b66
const WHITE = 0xe9e3d7
const RED = 0xb4463b
const IRON = 0x2b2c33
/** The lantern's static light, and the lamp over the door. */
export const LANTERN = 0xffd27a
const LAMP = 0xffc277
const WINDOW = 0xe8a95c

/** The tower's radius at a height, from its foot to the gallery. */
const GALLERY_Y = 9.3
const towerRadius = (y: number) => FARO.towerRadius - ((FARO.towerRadius - 0.85) * (y - FARO.top)) / (GALLERY_Y - FARO.top)

/** Where the boardwalk's piles go down to: under the water, which is opaque. */
const PILE_FOOT = -0.6

/** A rail: posts at its ends and every metre and a half, a top rail and a middle one. */
function rail(p: Painter, box: Box): void {
  const long = box.hx > box.hz
  const half = long ? box.hx : box.hz
  const posts = Math.max(1, Math.ceil((half * 2) / 1.5))
  const base = FARO.top
  for (let i = 0; i <= posts; i++) {
    const t = -half + (i * half * 2) / posts
    const c: V3 = long ? [box.cx + t, base + RAIL_HEIGHT / 2, box.cz] : [box.cx, base + RAIL_HEIGHT / 2, box.cz + t]
    p.box(c, [RAIL_HALF, RAIL_HEIGHT / 2, RAIL_HALF], WOOD_DARK)
  }
  for (const [y, h] of [
    [RAIL_HEIGHT - 0.04, 0.04],
    [RAIL_HEIGHT * 0.55, 0.03],
  ] as const)
    p.box([box.cx, base + y, box.cz], long ? [box.hx, h, RAIL_HALF * 0.8] : [RAIL_HALF * 0.8, h, box.hz], WOOD)
}

/** The Faro, its rock, its deck and its boardwalk, in the world's frame: one geometry. */
export function faroGeometry(): BufferGeometry {
  const p = new Painter()
  const next = random(24)
  const { x, z, deckHalf: d, top } = FARO

  // The rock: a few rough rings from the mouth's floor, out of the water round the deck, and down under its planks.
  const rings: Array<[number, number]> = [
    [-2.8, 4.6],
    [-0.9, 4.3],
    [0.3, 3.95],
    [0.5, 3.45],
    [0.12, 2.9],
  ]
  const segments = 16
  const jitter = rings.map(() => Array.from({ length: segments }, () => 0.85 + next() * 0.3))
  const ring = (k: number, i: number): V3 => {
    const a = ((i % segments) / segments) * Math.PI * 2
    const r = rings[k][1] * jitter[k][i % segments]
    return [x + Math.sin(a) * r, rings[k][0] + (k > 0 && k < rings.length - 1 ? (next() - 0.5) * 0.2 : 0), z - Math.cos(a) * r]
  }
  const points = rings.map((_, k) => Array.from({ length: segments }, (_, i) => ring(k, i)))
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < segments; i++) {
      const a = points[k][i]
      const b = points[k][(i + 1) % segments]
      const c = points[k + 1][(i + 1) % segments]
      const e = points[k + 1][i]
      const mid = ((i + 0.5) / segments) * Math.PI * 2
      const rise = (rings[k][1] - rings[k + 1][1]) / Math.max(0.05, rings[k + 1][0] - rings[k][0])
      const n: V3 = [Math.sin(mid), rise, -Math.cos(mid)]
      const l = Math.hypot(...n)
      p.face([a, b, c, e], [n[0] / l, n[1] / l, n[2] / l], ROCK)
    }
  }
  const crown = points[rings.length - 1]
  for (let i = 0; i < segments; i++) p.face([[x, rings[rings.length - 1][0], z], crown[i], crown[(i + 1) % segments]], [0, 1, 0], ROCK)
  // Boulders round it, out of the water, where the deck's corners are not.
  for (const [angle, r, size] of [
    [0.5, 4.2, 0.9],
    [1.9, 4.4, 0.7],
    [2.7, 4.0, 1.1],
    [3.9, 4.3, 0.8],
    [5.3, 4.1, 1.0],
  ] as const)
    p.boulder([x + Math.sin(angle) * r, 0.05, z - Math.cos(angle) * r], size, ROCK, next)

  // The deck round the tower: planks along z, each its own shade of wood.
  const plank = 0.34
  for (let px = -d + plank / 2; px < d; px += plank) {
    const shade = next() < 0.5 ? WOOD : 0x80624a
    p.box([x + px, top - 0.05, z], [plank / 2 - 0.015, 0.05, d], shade)
  }
  // Its beams, showing at the edge over the rock.
  for (const side of [-1, 1]) p.box([x + side * (d - 0.1), top - 0.17, z], [0.1, 0.07, d], WOOD_DARK)

  // The boardwalk from the islet: planks across, two stringers, and piles every couple of metres.
  const w = FARO_WALK.halfWidth
  for (let pz = FARO_WALK.fromZ + plank / 2; pz < FARO_WALK.toZ; pz += plank) {
    const shade = next() < 0.5 ? WOOD : 0x80624a
    p.box([x, top - 0.05, pz], [w, 0.05, plank / 2 - 0.015], shade)
  }
  const length = FARO_WALK.toZ - FARO_WALK.fromZ
  for (const side of [-1, 1]) p.box([x + side * (w - 0.2), top - 0.16, FARO_WALK.fromZ + length / 2], [0.06, 0.06, length / 2], WOOD_DARK)
  for (let pz = FARO_WALK.fromZ + 1.2; pz < FARO_WALK.toZ; pz += 2.2)
    for (const side of [-1, 1]) p.box([x + side * (w - 0.08), (PILE_FOOT + top - 0.2) / 2, pz], [0.08, (top - 0.2 - PILE_FOOT) / 2, 0.08], WOOD_DARK)

  // The rails, where `faroBoxes` puts them.
  for (const box of faroBoxes().slice(4)) rail(p, box)

  // The tower: white with red bands, narrowing to the gallery.
  const bands = 6
  for (let i = 0; i < bands; i++) {
    const y0 = top + ((GALLERY_Y - top) * i) / bands
    const y1 = top + ((GALLERY_Y - top) * (i + 1)) / bands
    p.band(x, z, y0, y1, towerRadius(y0), towerRadius(y1), 20, i % 2 === 0 ? WHITE : RED)
  }
  // The door toward the islet, its frame, and the lamp over it.
  const doorZ = FARO_DOOR.z + 0.02
  p.box([x, top + 1.08, doorZ - 0.01], [0.56, 1.08, 0.05], WHITE)
  p.box([x, top + 1.0, doorZ - 0.04], [0.45, 1.0, 0.05], 0x4a3426)
  p.box([x, top + 2.42, doorZ - 0.12], [0.11, 0.09, 0.09], LAMP, 0, true)
  // Two small windows up the tower, lit.
  for (const y of [4.2, 6.9]) {
    const r = towerRadius(y)
    p.box([x, y, z - r + 0.02], [0.17, 0.27, 0.04], WINDOW, 0, true)
  }
  // The gallery, its posts, the lantern and the cap.
  p.band(x, z, GALLERY_Y, GALLERY_Y + 0.16, 1.32, 1.32, 20, IRON, true)
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    p.box([x + Math.sin(a) * 1.26, GALLERY_Y + 0.5, z - Math.cos(a) * 1.26], [0.03, 0.34, 0.03], IRON)
  }
  p.band(x, z, GALLERY_Y + 0.82, GALLERY_Y + 0.86, 1.28, 1.28, 20, IRON)
  p.band(x, z, GALLERY_Y + 0.16, GALLERY_Y + 1.25, 0.64, 0.64, 12, LANTERN, false, true)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    p.box([x + Math.sin(a) * 0.66, GALLERY_Y + 0.7, z - Math.cos(a) * 0.66], [0.035, 0.55, 0.035], IRON)
  }
  p.band(x, z, GALLERY_Y + 1.25, FARO.towerTop - 0.1, 0.86, 0, 12, RED)
  p.box([x, FARO.towerTop - 0.05, z], [0.05, 0.1, 0.05], IRON)
  return p.geometry()
}

/** The pictures the places draw, in pixels: the lantern's halo and the kiosk's sign. */
export const HALO_SIZE = 64
export const SIGN_SIZE = { width: 256, height: 64 }

/** The halo round the lantern: a soft disc of its colour, drawn once. */
function haloTexture(): CanvasTexture | undefined {
  if (typeof document === "undefined") return undefined
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = HALO_SIZE
  const ctx = canvas.getContext("2d")
  if (!ctx) return undefined
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, "rgba(255,214,140,0.9)")
  g.addColorStop(0.35, "rgba(255,190,110,0.35)")
  g.addColorStop(1, "rgba(255,170,90,0)")
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** The kiosk's word, small: a board is a metre and a half wide, a few dozen pixels on the screen. */
function signTexture(word: string): CanvasTexture | undefined {
  if (typeof document === "undefined") return undefined
  const canvas = document.createElement("canvas")
  canvas.width = SIGN_SIZE.width
  canvas.height = SIGN_SIZE.height
  const ctx = canvas.getContext("2d")
  if (!ctx) return undefined
  ctx.fillStyle = "#0f141c"
  ctx.fillRect(0, 0, 256, 64)
  ctx.strokeStyle = "#e8dcc4"
  ctx.lineWidth = 3
  ctx.strokeRect(4, 4, 248, 56)
  ctx.fillStyle = "#f3d27a"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.font = "700 38px system-ui, sans-serif"
  ctx.fillText(word, 128, 35)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/**
 * The triangles of a mesh's geometry that lie within `half` of a point on the ground, moved so the point is the
 * origin: a piece cut out of a merged one (a post out of the fixtures). Every attribute is kept.
 */
export function cutOut(source: BufferGeometry, at: { x: number; z: number }, half: number): BufferGeometry | undefined {
  const pos = source.getAttribute("position")
  const index = source.index
  const count = index ? index.count : pos.count
  const vertex = (i: number) => (index ? index.getX(i) : i)
  const kept: number[] = []
  for (let t = 0; t + 2 < count; t += 3) {
    const vs = [vertex(t), vertex(t + 1), vertex(t + 2)]
    if (vs.every((v) => Math.abs(pos.getX(v) - at.x) < half && Math.abs(pos.getZ(v) - at.z) < half)) kept.push(...vs)
  }
  if (kept.length === 0) return undefined
  const out = new BufferGeometry()
  for (const name of Object.keys(source.attributes)) {
    const attr = source.getAttribute(name)
    const size = attr.itemSize
    const data = new Float32Array(kept.length * size)
    kept.forEach((v, i) => {
      for (let c = 0; c < size; c++) data[i * size + c] = attr.getComponent(v, c)
      if (name === "position") {
        data[i * size] -= at.x
        data[i * size + 2] -= at.z
      }
    })
    out.setAttribute(name, new BufferAttribute(data, size))
  }
  out.computeBoundingSphere()
  return out
}

/** Where a chiringuito's front right post stands in the fixtures (`layout.ts` `POSTS`). */
const SOURCE_POST = { x: 2.8, z: 0.75 }

export interface PlacesView {
  group: Group
  faro: Group
  kiosk: Group
  /** Everything the places made, for the budget: geometries, materials and textures that are theirs alone. */
  own(): Array<BufferGeometry | Material | CanvasTexture>
  dispose(): void
}

/** The kiosk from the file's pieces, in its own frame (+z toward the hologram); undefined when a piece is missing. */
function kioskFromKit(kit: CityKit, lang: WorldLang, own: Array<BufferGeometry | Material | CanvasTexture>): Group | undefined {
  const counter = kit.piece("chir_bar1_counter") ?? kit.piece("chir_bar0_counter")
  const roof = kit.piece("chir_roof2_roof")
  const stripes = kit.piece("chir_roof2_stripes")
  const board = kit.piece("chir_sign0_board")
  const fixtures = kit.piece("chir_base_fixtures")
  const post = fixtures ? cutOut(fixtures.geometry, SOURCE_POST, 0.3) : undefined
  if (!counter || !roof || !stripes || !board || !fixtures || !post) return undefined
  own.push(post)
  const group = new Group()
  // The counter, narrowed to the kiosk's (the file's spans 3.8 m, from its back at z 0 to its front at 0.7).
  counter.scale.set((KIOSK_COUNTER.hx * 2) / 3.8, 1, 0.9)
  counter.position.z = KIOSK_COUNTER.z - 0.35 * 0.9
  group.add(counter)
  for (const at of KIOSK_POSTS) {
    const mesh = new Mesh(post, fixtures.material)
    mesh.name = "kiosk_post"
    mesh.position.set(at.x, 0, at.z)
    group.add(mesh)
  }
  // The striped awning over the posts, at half the chiringuito's size, in a colour of its own.
  const awning = (stripes.material as MeshBasicMaterial).clone()
  awning.color.multiply(new Color(0xd8a24a))
  own.push(awning)
  stripes.material = awning
  for (const mesh of [roof, stripes]) {
    mesh.scale.set(0.5, 1, 0.5)
    mesh.position.set(0, EAVE_HEIGHT - 2.3, 0.33)
    group.add(mesh)
  }
  // The sign over the counter, under the awning's front, with the word.
  board.scale.setScalar(0.62)
  board.position.set(0, 1.0, 0.45)
  group.add(board)
  const texture = signTexture(kioskSign(lang))
  const material = texture ? new MeshBasicMaterial({ map: texture }) : new MeshBasicMaterial({ color: 0x0f141c })
  own.push(material)
  if (texture) own.push(texture)
  const plane = new PlaneGeometry(1, 1)
  own.push(plane)
  const word = new Mesh(plane, material)
  word.name = "kiosk_sign"
  word.scale.set(1.7 * 0.62, 0.32 * 0.62, 1)
  word.position.set(0, 1.0 + 2.02 * 0.62, 0.45 + 1.01 * 0.62 + 0.005)
  group.add(word)
  return group
}

/** The kiosk as plain boxes, for the city without its file. */
function kioskPlain(own: Array<BufferGeometry | Material | CanvasTexture>): Group {
  const group = new Group()
  const box = new BoxGeometry(1, 1, 1)
  const wood = new MeshBasicMaterial({ color: WOOD })
  const cloth = new MeshBasicMaterial({ color: 0xd8a24a })
  own.push(box, wood, cloth)
  const counter = new Mesh(box, wood)
  counter.scale.set(KIOSK_COUNTER.hx * 2, KIOSK_COUNTER.height, KIOSK_COUNTER.hz * 2)
  counter.position.set(KIOSK_COUNTER.x, KIOSK_COUNTER.height / 2, KIOSK_COUNTER.z)
  group.add(counter)
  for (const at of KIOSK_POSTS) {
    const post = new Mesh(box, wood)
    post.scale.set(0.12, EAVE_HEIGHT, 0.12)
    post.position.set(at.x, EAVE_HEIGHT / 2, at.z)
    group.add(post)
  }
  const roof = new Mesh(box, cloth)
  roof.scale.set(3.1, 0.15, 2.1)
  roof.position.set(0, EAVE_HEIGHT + 0.07, 0)
  group.add(roof)
  return group
}

export function createPlaces(kit: CityKit | undefined, lang: WorldLang): PlacesView {
  const own: Array<BufferGeometry | Material | CanvasTexture> = []
  const group = new Group()
  group.name = "places"

  const faro = new Group()
  faro.name = "faro"
  const geometry = faroGeometry()
  const material = new MeshBasicMaterial({ vertexColors: true })
  own.push(geometry, material)
  const body = new Mesh(geometry, material)
  body.name = "faro_body"
  faro.add(body)
  const halo = haloTexture()
  if (halo) {
    const glow = new SpriteMaterial({ map: halo, blending: AdditiveBlending, depthWrite: false, transparent: true })
    own.push(halo, glow)
    const sprite = new Sprite(glow)
    sprite.name = "faro_halo"
    sprite.position.set(FARO.x, GALLERY_Y + 0.7, FARO.z)
    sprite.scale.setScalar(3.4)
    faro.add(sprite)
  }
  group.add(faro)

  const kiosk = (kit && kioskFromKit(kit, lang, own)) || kioskPlain(own)
  kiosk.name = "kiosk"
  const placement = kioskPlacement()
  kiosk.position.set(placement.center.x, kit?.island ? islandHeight(placement.center) : 0, placement.center.z)
  kiosk.rotation.y = placement.yaw
  group.add(kiosk)

  // Nothing here moves: the matrices are worked out once, not at every frame.
  group.updateMatrixWorld(true)
  group.traverse((o) => {
    o.matrixAutoUpdate = false
  })

  return {
    group,
    faro,
    kiosk,
    own: () => [...own],
    dispose() {
      for (const o of own) o.dispose()
      own.length = 0
    },
  }
}
