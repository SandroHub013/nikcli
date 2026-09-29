/**
 * The city's pieces from `city.glb`: the plaza with everything around it, and the shops.
 *
 * The file has the pieces as meshes, each in its own frame: the plaza and its surroundings in the world's (the
 * square at the origin), and a shop in its own (floor at y = 0, the door on +z, the desks facing -z). A shop is
 * the meshes named `shop<variant>_*` (`shop_*` is variant 0): the file has a few, and each project gets one of
 * them by the hash of its name, with the colours of its walls and awning. What changes from one shop to the next
 * beyond that (the sign's text, the monitors' colour) is added over them by `view.ts`; the pieces are shared,
 * geometry and material.
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
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MultiplyBlending,
  RepeatWrapping,
  SRGBColorSpace,
  type Material,
  type Object3D,
  type Texture,
} from "three/webgpu"
import { cityUrl, loadCityFile, type CastDeps } from "./assets"
import type { Loaded } from "./rig"

export interface ShopTint {
  /** The plaster of the walls, `0xRRGGBB` in sRGB. */
  wall: number
  /** The awning's colour. */
  awning: number
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
  /** Whether every lightmap the file asks for was loaded. */
  lit: boolean
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
  const cache = new Map<string, Material>()
  let ringY = 0
  for (const child of loaded.scene.children) {
    if (named(child, "plaza_ring")) {
      ringY = Math.max(ringY, child.position.y)
      continue
    }
    if (!(child as Mesh).isMesh) continue
    const mesh = (child as Mesh).clone()
    const material = drawnWith(mesh, maps, cache)
    if (material) mesh.material = material
    const shop = SHOP_NAME.exec(child.name)
    if (shop) {
      const variant = shop[1] ? Number(shop[1]) : 0
      if (!variants.has(variant)) variants.set(variant, [])
      variants.get(variant)!.push(mesh)
    } else plaza.add(mesh)
  }
  const kinds = [...variants.keys()].sort((a, b) => a - b)
  if (!plaza.children.length || !kinds.length) throw new Error("city.glb senza la piazza o senza il negozio")
  const tinted = new Map<string, Material>()
  const tintOf = (material: Material, tint: ShopTint | undefined, role: unknown): Material => {
    if (!tint || (role !== "wall" && role !== "awning")) return material
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
    return texture
  } catch (error) {
    // The city is drawn without this baked light instead of not being drawn at all.
    deps.warn?.(`${url}: lightmap non decodificata (${String((error as Error)?.message ?? error).slice(0, 120)})`)
    return undefined
  }
}

export { cityUrl }
