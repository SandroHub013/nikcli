/**
 * The city's pieces from `city.glb`: the plaza (or the island) with everything around it, and the shops.
 *
 * The file has the pieces as meshes, each in its own frame: the plaza and its surroundings in the world's (the
 * square at the origin), and a shop in its own (ground at y = 0, the front on +z, the seats facing -z).
 *
 * On the island a shop is a chiringuito put together from parts: `chir_base_*` (the posts, the back bar, the
 * seats, the loungers, what every one has), one roof `chir_roof<k>_*`, one counter `chir_bar<k>_*` and one sign
 * `chir_sign<k>_*`. Every combination is a variant, and each project gets one by the hash of its name, with an
 * accent colour (the awning's stripes, the cushions). A sign carries an empty `chir_sign<k>_signtext`: where the
 * project's name is drawn, facing its +z, as wide and tall as its scale. An older file has whole shops instead,
 * `shop<variant>_*` (`shop_*` is variant 0).
 *
 * What changes from one shop to the next beyond that (the sign's text, the screens' colour) is added over them by
 * `view.ts`; the pieces are shared, geometry and material.
 *
 * The island's plants are instances: a prototype mesh for each piece, `veg_<set>_<piece>` (the near plant's leaves
 * and its cola, the far one's, the palm), and an empty `veg_<set>` with the instances in its `nkv_instances`,
 * `VEG_STRIDE` numbers each in the world's frame (x, y, z, turn about y, scale, and a linear r, g, b). A piece with
 * `nkv_instance_tint` takes each instance's colour (the colas, one variety to a terrace); the rest keep their own.
 * Each set is split into `VEG_SECTORS` slices of the circle, one instanced mesh each, so that what is behind the
 * camera is not drawn.
 *
 * The light is baked (A2): the file says how each mesh is drawn in its `extras`, which the loader puts in
 * `userData`. `nkv_shade` is `lit` (its colour times its lightmap, on the second set of UVs, named by `nkv_lm`),
 * `vcol` (its colour times the light baked in its vertices), `emit` (its colour as it is: lamps, screens, glow),
 * `add` or `mul` (a halo added over what is behind it, or a contact shadow that darkens it). All of them are
 * unlit materials: the scene's lights do not touch the city, only the people. `nkv_fog: 0` keeps a mesh out of
 * the fog (the sky dome, the stars, the moon). A mesh without `nkv_shade` (an older file) keeps the material the
 * file gave it.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MultiplyBlending,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
  type Material,
  type Object3D,
  type Texture,
} from "three/webgpu"
import { cityUrl, loadCityFile, type CastDeps } from "./assets"
import type { Loaded } from "./rig"
import { releaseAfterUpload } from "./upload-release"

export interface ShopTint {
  /** The plaster of the walls, `0xRRGGBB` in sRGB. */
  wall: number
  /** The awning's colour: on a chiringuito, the accent (the stripes, the cushions). */
  awning: number
}

/** Where a sign's text goes, in the shop's frame: its middle, its turn about y, its size. */
export interface SignAnchor {
  x: number
  y: number
  z: number
  yaw: number
  width: number
  height: number
}

export interface CityKit {
  /** The plaza and what is around it, in the world's frame: paving, pedestal, lamps, gardens, street, skyline. */
  plaza: Group
  /** How high above the ground the hologram's ring is meant to float: the `plaza_ring` anchor. */
  ringY: number
  /** How many shops the file has to choose from. */
  variants: number
  /**
   * A shop's pieces, in the shop's own frame: variant `variant` (taken modulo `variants`) with the tint's colours.
   * Two shops of the same variant and tint share every geometry and material.
   */
  shop(variant?: number, tint?: ShopTint): Group
  /**
   * The same shop as it is drawn: the pieces that end up with one material (the palette's wood and thatch, the
   * tinted accents, the lamps) merged into one mesh, so that a chiringuito is a handful of draw calls and not a dozen.
   * The merged geometry is made once for a variant and shared by every shop that has it.
   */
  drawnShop(variant?: number, tint?: ShopTint): Group
  /** Whether every lightmap the file asks for was loaded. */
  lit: boolean
  /** Whether the file is the island (its ground has heights: `islandHeight`), not a flat city. */
  island: boolean
  /** Where variant `variant`'s sign wants the project's name, if the file says. */
  signOf(variant: number): SignAnchor | undefined
}

/** How strongly the baked light is added to what the scene lights, on N3's older files. */
export const LIGHTMAP_INTENSITY = 0.5

/**
 * The generator saves light divided by this, so that a pool under a lamp (up to four times the light of a lit
 * wall) fits in a picture; the world multiplies it back. It must be the generator's `LIGHT_SCALE`.
 */
export const LIGHT_SCALE = 4

/** Colours a project's shop can have: warm plasters and awnings that stay off the states' saturated colours. */
export const SHOP_TINTS: ReadonlyArray<ShopTint> = [
  { wall: 0xe9dcc4, awning: 0x2f6f73 },
  { wall: 0xd98f6a, awning: 0xf1ecec },
  { wall: 0xb9c7b0, awning: 0x7a4a3a },
  { wall: 0xa9b8c9, awning: 0xd8a24a },
  { wall: 0xe2c07f, awning: 0x3d4b6a },
  { wall: 0xc9a9b6, awning: 0x4f6b3a },
]

/** A stable hash of a project's name: the same shop every time the city is drawn. */
export function nameHash(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Which variant and tint a project's shop gets. */
export function shopLook(name: string, variants: number): { variant: number; tint: ShopTint } {
  const h = nameHash(name)
  return { variant: variants > 0 ? h % variants : 0, tint: SHOP_TINTS[Math.floor(h / 7) % SHOP_TINTS.length] }
}

/** three.js takes the dots out of a node's name (`streetlight.001` is `streetlight001`); the kit matches by the start. */
const named = (o: Object3D, prefix: string) => o.name.startsWith(prefix)

const SHOP_NAME = /^shop(\d*)_/
/** A plant's piece (`veg_lod0_leaves`) and the empty that holds a set's instances (`veg_lod0`). */
const VEG_PIECE = /^veg_([a-z0-9]+)_([a-z]+)$/
const VEG_SET = /^veg_([a-z0-9]+)$/
/** Numbers per instance in `nkv_instances`: x, y, z, turn, scale, r, g, b. */
export const VEG_STRIDE = 8
/** The slices of the circle the plants are drawn in: two LODs of leaves and colas in four slices, the plan's 16 draw calls. */
export const VEG_SECTORS = 4
/** A set with no more instances than this (the palms) is one mesh: slicing it would only add draw calls. */
export const VEG_WHOLE_UP_TO = 64

/** Which slice of the circle a point of the ground is in, 0..VEG_SECTORS-1. */
export const vegSector = (x: number, z: number): number =>
  Math.min(VEG_SECTORS - 1, Math.floor(((Math.atan2(x, z) + Math.PI) / (2 * Math.PI)) * VEG_SECTORS))

/** A prototype drawn at every instance of its set, one instanced mesh a slice of the circle. */
function planted(proto: Mesh, list: readonly number[], tinted: boolean): InstancedMesh[] {
  const slices: number[][] = Array.from({ length: VEG_SECTORS }, () => [])
  const whole = list.length / VEG_STRIDE <= VEG_WHOLE_UP_TO
  for (let i = 0; i + VEG_STRIDE <= list.length; i += VEG_STRIDE) slices[whole ? 0 : vegSector(list[i], list[i + 2])].push(i)
  const matrix = new Matrix4()
  const at = new Vector3()
  const turn = new Quaternion()
  const size = new Vector3()
  const up = new Vector3(0, 1, 0)
  const colour = new Color()
  const out: InstancedMesh[] = []
  for (const [sector, starts] of slices.entries()) {
    if (starts.length === 0) continue
    const mesh = new InstancedMesh(proto.geometry, proto.material, starts.length)
    mesh.name = proto.name
    mesh.userData = { ...proto.userData, nkv_sector: whole ? -1 : sector }
    for (const [k, i] of starts.entries()) {
      at.set(list[i], list[i + 1], list[i + 2])
      turn.setFromAxisAngle(up, list[i + 3])
      size.setScalar(list[i + 4])
      mesh.setMatrixAt(k, matrix.compose(at, turn, size))
      // The file's colours are linear, as three works.
      if (tinted) mesh.setColorAt(k, colour.setRGB(list[i + 5], list[i + 6], list[i + 7]))
    }
    mesh.computeBoundingSphere()
    out.push(mesh)
  }
  return out
}

/**
 * Several meshes' geometries as one, in the frame of the first's parent: every attribute they all have, as floats
 * (the file's may be quantized), and the indices one after the other. Undefined when they do not share their
 * attributes, and then they are drawn apart.
 */
function mergedGeometry(meshes: readonly Mesh[]): BufferGeometry | undefined {
  const names = Object.keys(meshes[0].geometry.attributes).sort()
  if (!meshes.every((m) => Object.keys(m.geometry.attributes).sort().join() === names.join())) return undefined
  const sources = meshes.map((m) => {
    m.updateMatrix()
    return m.matrix.equals(new Matrix4()) ? m.geometry : m.geometry.clone().applyMatrix4(m.matrix)
  })
  const out = new BufferGeometry()
  for (const name of names) {
    const size = sources[0].getAttribute(name).itemSize
    if (!sources.every((g) => g.getAttribute(name).itemSize === size)) return undefined
    const total = sources.reduce((n, g) => n + g.getAttribute(name).count, 0)
    const data = new Float32Array(total * size)
    let at = 0
    for (const g of sources) {
      const attr = g.getAttribute(name)
      for (let i = 0; i < attr.count; i++) for (let c = 0; c < size; c++) data[at++] = attr.getComponent(i, c)
    }
    out.setAttribute(name, new BufferAttribute(data, size))
  }
  const indices: number[] = []
  let offset = 0
  for (const g of sources) {
    const count = g.getAttribute("position").count
    if (g.index) for (let i = 0; i < g.index.count; i++) indices.push(g.index.getX(i) + offset)
    else for (let i = 0; i < count; i++) indices.push(i + offset)
    offset += count
  }
  out.setIndex(indices)
  out.computeBoundingSphere()
  return out
}

/** A chiringuito's part: `chir_base_*`, or a roof, a counter or a sign of some kind. */
const PART_NAME = /^chir_(base|roof|bar|sign)(\d*)_/

/** The lightmaps of a file, by the name its meshes give (`nkv_lm`). */
export type Lightmaps = Map<string, Texture>

/** The lightmaps a file's meshes ask for. */
export function lightmapNames(loaded: Loaded): string[] {
  const names = new Set<string>()
  loaded.scene.traverse((o) => {
    const lm = o.userData?.nkv_lm
    if (typeof lm === "string" && /^[a-z0-9_]+\.(png|ktx2)$/.test(lm)) names.add(lm)
  })
  return [...names].sort()
}

/** The unlit material a mesh is drawn with, from the file's material and what `extras` says. */
function drawnWith(mesh: Mesh, maps: Lightmaps, cache: Map<string, Material>): Material | undefined {
  const shade = mesh.userData?.nkv_shade
  if (typeof shade !== "string") return undefined
  const source = mesh.material as MeshStandardMaterial
  const lm = typeof mesh.userData.nkv_lm === "string" ? (mesh.userData.nkv_lm as string) : ""
  // The sky and what hangs on it (`nkv_fog: 0`) stay out of the fog: they are the distance the fog fades into.
  const fog = mesh.userData.nkv_fog !== 0
  const key = `${source.uuid}|${shade}|${lm}|${fog}`
  const known = cache.get(key)
  if (known) return known
  const material = new MeshBasicMaterial({ name: source.name, map: source.map ?? null, side: source.side, fog })
  if (source.map) {
    // The pictures are decoded out of the loader (`assets.ts`), so they miss the file's sampler: the city's tile
    // textures repeat, and clamped they smear their edge pixels across the ground in long streaks.
    source.map.wrapS = source.map.wrapT = RepeatWrapping
    source.map.needsUpdate = true
  }
  if (!source.map) material.color.copy(source.color)
  if (shade === "lit") {
    const map = maps.get(lm)
    if (map) {
      map.channel = 1
      material.lightMap = map
      material.lightMapIntensity = LIGHT_SCALE * Math.PI
    }
  } else if (shade === "vcol") {
    material.vertexColors = mesh.geometry.hasAttribute("color")
    if (material.vertexColors) material.color.multiplyScalar(LIGHT_SCALE)
  } else if (shade === "emit" || shade === "add" || shade === "mul") {
    const glow = source.emissive && source.emissive.getHex() !== 0 ? source.emissive : source.color
    if (!source.map) material.color.copy(glow)
    // A decal baked in its vertices (a chiringuito's shadow and lamp pool on the sand) is its vertex colours.
    if (shade !== "emit" && mesh.geometry.hasAttribute("color")) {
      material.vertexColors = true
      material.color.setRGB(1, 1, 1)
    }
    if (shade !== "emit") {
      material.transparent = true
      material.depthWrite = false
      material.blending = shade === "add" ? AdditiveBlending : MultiplyBlending
      if (shade === "mul") material.premultipliedAlpha = true
    }
  }
  cache.set(key, material)
  return material
}

export function kitOf(loaded: Loaded, maps: Lightmaps = new Map(), wanted: string[] = []): CityKit {
  const plaza = new Group()
  plaza.name = "plaza"
  const variants = new Map<number, Mesh[]>()
  /** A chiringuito's parts by kind (`base`, `roof`, `bar`, `sign`) and number. */
  const parts = new Map<string, Map<number, Mesh[]>>()
  const signs = new Map<number, SignAnchor>()
  const cache = new Map<string, Material>()
  /** A variant's pieces merged by material, made once (`null`: they could not be merged). */
  const merged = new Map<string, BufferGeometry | null>()
  /** The plants: each set's prototypes, and its instances. */
  const vegPieces = new Map<string, Mesh[]>()
  const vegInstances = new Map<string, readonly number[]>()
  let ringY = 0
  for (const child of loaded.scene.children) {
    const set = VEG_SET.exec(child.name)
    if (set && Array.isArray(child.userData?.nkv_instances)) {
      vegInstances.set(set[1], child.userData.nkv_instances as number[])
      continue
    }
    if (named(child, "plaza_ring")) {
      ringY = Math.max(ringY, child.position.y)
      continue
    }
    const part = PART_NAME.exec(child.name)
    if (part && part[1] === "sign" && child.name.endsWith("_signtext")) {
      signs.set(Number(part[2] || 0), {
        x: child.position.x,
        y: child.position.y,
        z: child.position.z,
        yaw: child.rotation.y,
        width: child.scale.x,
        height: child.scale.y,
      })
      continue
    }
    if (!(child as Mesh).isMesh) continue
    const mesh = (child as Mesh).clone()
    const material = drawnWith(mesh, maps, cache)
    if (material) mesh.material = material
    const shop = SHOP_NAME.exec(child.name)
    const piece = VEG_PIECE.exec(child.name)
    if (piece) vegPieces.set(piece[1], [...(vegPieces.get(piece[1]) ?? []), mesh])
    else if (part) {
      const byNumber = parts.get(part[1]) ?? new Map<number, Mesh[]>()
      parts.set(part[1], byNumber)
      const n = Number(part[2] || 0)
      byNumber.set(n, [...(byNumber.get(n) ?? []), mesh])
    } else if (shop) {
      const variant = shop[1] ? Number(shop[1]) : 0
      if (!variants.has(variant)) variants.set(variant, [])
      variants.get(variant)!.push(mesh)
    } else plaza.add(mesh)
  }
  for (const [set, pieces] of vegPieces) {
    const list = vegInstances.get(set) ?? []
    for (const proto of pieces) for (const mesh of planted(proto, list, proto.userData.nkv_instance_tint === 1)) plaza.add(mesh)
  }
  // The chiringuiti: one variant for every roof, counter and sign together.
  const kindsOf = (kind: string) => [...(parts.get(kind)?.keys() ?? [])].sort((a, b) => a - b)
  const [roofs, bars, signKinds] = [kindsOf("roof"), kindsOf("bar"), kindsOf("sign")]
  const combine = (v: number) => {
    const r = roofs.length ? v % roofs.length : 0
    const b = bars.length ? Math.floor(v / Math.max(1, roofs.length)) % bars.length : 0
    const s = signKinds.length ? Math.floor(v / Math.max(1, roofs.length * bars.length)) % signKinds.length : 0
    return { roof: roofs[r], bar: bars[b], sign: signKinds[s] }
  }
  if (parts.has("base")) {
    const count = Math.max(1, roofs.length) * Math.max(1, bars.length) * Math.max(1, signKinds.length)
    for (let v = 0; v < count; v++) {
      const c = combine(v)
      variants.set(v, [
        ...(parts.get("base")?.get(0) ?? []),
        ...(parts.get("roof")?.get(c.roof) ?? []),
        ...(parts.get("bar")?.get(c.bar) ?? []),
        ...(parts.get("sign")?.get(c.sign) ?? []),
      ])
    }
  }
  const kinds = [...variants.keys()].sort((a, b) => a - b)
  if (!plaza.children.length || !kinds.length) throw new Error("city.glb senza la piazza o senza il negozio")
  const tinted = new Map<string, Material>()
  const tintOf = (material: Material, tint: ShopTint | undefined, role: unknown): Material => {
    if (!tint || (role !== "wall" && role !== "awning" && role !== "accent")) return material
    const hex = role === "wall" ? tint.wall : tint.awning
    const key = `${material.uuid}|${hex}`
    let copy = tinted.get(key)
    if (!copy) {
      copy = material.clone()
      ;(copy as MeshBasicMaterial).color.multiply(new Color(hex))
      tinted.set(key, copy)
    }
    return copy
  }
  return {
    plaza,
    ringY,
    variants: kinds.length,
    lit: wanted.every((name) => maps.has(name)),
    island: plaza.children.some((o) => named(o, "island_")),
    signOf(variant) {
      if (!signs.size) return undefined
      return signs.get(combine(((variant % kinds.length) + kinds.length) % kinds.length).sign)
    },
    shop(variant = 0, tint) {
      const pieces = variants.get(kinds[((variant % kinds.length) + kinds.length) % kinds.length])!
      const group = new Group()
      for (const mesh of pieces) {
        const copy = mesh.clone()
        copy.material = tintOf(mesh.material as Material, tint, mesh.userData?.nkv_tint)
        group.add(copy)
      }
      return group
    },
    drawnShop(variant = 0, tint) {
      const kind = kinds[((variant % kinds.length) + kinds.length) % kinds.length]
      const pieces = variants.get(kind)!
      // The same material, the same mesh: a tinted piece's material is the tint's, shared by the pieces with that role.
      const byMaterial = new Map<Material, Mesh[]>()
      for (const mesh of pieces) {
        const material = tintOf(mesh.material as Material, tint, mesh.userData?.nkv_tint)
        byMaterial.set(material, [...(byMaterial.get(material) ?? []), mesh])
      }
      const group = new Group()
      for (const [material, meshes] of byMaterial) {
        const names = meshes.map((m) => m.name).join("+")
        const key = `${kind}|${names}`
        let geometry = merged.get(key)
        if (geometry === undefined && meshes.length > 1) {
          geometry = mergedGeometry(meshes) ?? null
          merged.set(key, geometry)
        }
        if (meshes.length === 1 || !geometry) {
          for (const mesh of meshes) {
            const copy = mesh.clone()
            copy.material = material
            group.add(copy)
          }
          continue
        }
        const mesh = new Mesh(geometry, material)
        mesh.name = names
        mesh.userData = { ...meshes[0].userData }
        group.add(mesh)
      }
      return group
    },
  }
}

export interface KitDeps extends CastDeps {
  /** Decodes the lightmaps too; without it the city is drawn without its baked light (a test). */
  decode?(bytes: Uint8Array, srgb: boolean): Promise<Texture>
}

/** Loads `city.glb` of a level and the lightmaps its meshes ask for. */
export async function loadKit(deps: KitDeps): Promise<CityKit> {
  const loaded = await loadCityFile(deps)
  const wanted = lightmapNames(loaded)
  const maps: Lightmaps = new Map()
  await Promise.all(
    wanted.map(async (name) => {
      const map = await lightmap(deps, name)
      if (map) maps.set(name, map)
    }),
  )
  return kitOf(loaded, maps, wanted)
}

async function lightmap(deps: KitDeps, name: string): Promise<Texture | undefined> {
  if (!deps.decode) return undefined
  const url = `${deps.base}levels/${deps.level}/lightmap/${name}`
  const bytes = await deps.fetchBytes(url).catch((error) => {
    throw new Error(`${url}: ${String(error?.message ?? error)}`)
  })
  try {
    const texture = await deps.decode(new Uint8Array(bytes), true)
    texture.colorSpace = SRGBColorSpace
    // Once the GPU has it, the CPU's copy goes (`upload-release.ts`).
    return releaseAfterUpload(texture)
  } catch (error) {
    // The city is drawn without this baked light instead of not being drawn at all.
    deps.warn?.(`${url}: lightmap non decodificata (${String((error as Error)?.message ?? error).slice(0, 120)})`)
    return undefined
  }
}

export { cityUrl }
