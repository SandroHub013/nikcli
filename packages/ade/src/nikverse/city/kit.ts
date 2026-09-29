/**
 * The city's pieces from N3's `city.glb`: the plaza with its pedestal, kerb and lamps, and one shop.
 *
 * The file has the pieces as meshes named `plaza_*`, `shop_*` and `streetlight*`, each in its own frame:
 * the plaza in the world's (the square at the origin) and the shop in its own (floor at y = 0, the door on
 * +z, the desks facing -z). The shop is many pieces, and what changes from one shop to the next (the sign's
 * text, the monitors' colour) is added over them by `view.ts`; the pieces are shared, geometry and material.
 *
 * The floors carry a baked lightmap on their second set of UVs, one for the plaza and one for the shop's
 * floor, which is the same in every shop. `m_pavement` is one material for both floors, so each floor gets
 * its own copy to hold its own map.
 */

import { Group, Mesh, MeshStandardMaterial, SRGBColorSpace, type Object3D, type Texture } from "three/webgpu"
import { cityUrl, loadCityFile, type CastDeps } from "./assets"
import type { Loaded } from "./rig"
import { releaseAfterUpload } from "./upload-release"

export interface CityKit {
  /** The plaza, in the world's frame: ground, pedestal, kerb, plots and lamps. */
  plaza: Group
  /** How high above the ground the hologram's ring is meant to float: the `plaza_ring` anchor. */
  ringY: number
  /** A shop's pieces, shared with every other shop, in the shop's own frame. */
  shop(): Group
  /** Whether the floors carry their baked lightmaps. */
  lit: boolean
}

/** The lightmap sizes by level, as the files are named. */
export const LIGHTMAP_SIZE: Readonly<Record<string, number>> = { bassa: 512, media: 1024, alta: 2048 }

/** How strongly the baked light is added to what the scene lights. */
export const LIGHTMAP_INTENSITY = 0.5

/** three.js takes the dots out of a node's name (`streetlight.001` is `streetlight001`); the kit matches by the start. */
const named = (o: Object3D, prefix: string) => o.name.startsWith(prefix)

export interface Lightmaps {
  plaza?: Texture
  shop?: Texture
}

/** A floor with its lightmap, on its own copy of the material. */
function lit(mesh: Mesh, map: Texture | undefined): void {
  if (!map) return
  const material = (mesh.material as MeshStandardMaterial).clone()
  map.channel = 1
  material.lightMap = map
  material.lightMapIntensity = LIGHTMAP_INTENSITY
  mesh.material = material
}

export function kitOf(loaded: Loaded, maps: Lightmaps = {}): CityKit {
  const plaza = new Group()
  plaza.name = "plaza"
  const shopMeshes: Mesh[] = []
  let ringY = 0
  for (const child of loaded.scene.children) {
    if (named(child, "plaza_ring")) ringY = Math.max(ringY, child.position.y)
    else if ((child as Mesh).isMesh) {
      const mesh = (child as Mesh).clone()
      if (named(child, "plaza_ground")) lit(mesh, maps.plaza)
      if (named(child, "shop_floor")) lit(mesh, maps.shop)
      if (named(child, "shop_")) shopMeshes.push(mesh)
      else if (named(child, "plaza_") || named(child, "streetlight")) plaza.add(mesh)
    }
  }
  if (!plaza.children.length || !shopMeshes.length) throw new Error("city.glb senza la piazza o senza il negozio")
  return {
    plaza,
    ringY,
    lit: Boolean(maps.plaza && maps.shop),
    shop() {
      const group = new Group()
      for (const mesh of shopMeshes) group.add(mesh.clone())
      return group
    },
  }
}

export interface KitDeps extends CastDeps {
  /** Decodes the lightmaps too; without it the floors stay unlit by them (a test). */
  decode?(bytes: Uint8Array, srgb: boolean): Promise<Texture>
}

/** Loads `city.glb` of a level and its two lightmaps. */
export async function loadKit(deps: KitDeps): Promise<CityKit> {
  const size = LIGHTMAP_SIZE[deps.level]
  const [loaded, plaza, shop] = await Promise.all([
    loadCityFile(deps),
    lightmap(deps, "plaza_ground", size),
    lightmap(deps, "shop_floor", size),
  ])
  return kitOf(loaded, { plaza, shop })
}

async function lightmap(deps: KitDeps, name: string, size: number): Promise<Texture | undefined> {
  if (!deps.decode) return undefined
  const url = `${deps.base}levels/${deps.level}/lightmap/${name}_${size}.ktx2`
  const bytes = await deps.fetchBytes(url).catch((error) => {
    throw new Error(`${url}: ${String(error?.message ?? error)}`)
  })
  try {
    const texture = await deps.decode(new Uint8Array(bytes), true)
    texture.colorSpace = SRGBColorSpace
    // Once the GPU has it, the CPU's copy goes (`upload-release.ts`).
    return releaseAfterUpload(texture)
  } catch (error) {
    // The floor is drawn without its baked light instead of the shop not being drawn at all.
    deps.warn?.(`${url}: lightmap non decodificata (${String((error as Error)?.message ?? error).slice(0, 120)})`)
    return undefined
  }
}

export { cityUrl }
