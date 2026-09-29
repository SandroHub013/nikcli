/**
 * Loads N3's files: the cast of a quality level (four `.glb`) and the city's (`city.glb`), parsed and dressed
 * with their pictures.
 *
 * Fetching and decoding a picture are passed in (`fetch` from the frame, `createImageBitmap`), so the same
 * code runs in a test on the files as they ship. The geometry is meshopt-compressed and decoded by the
 * decoder three.js carries (WebAssembly, which the world's policy allows).
 *
 * If any file of a set fails, the whole set fails and the city keeps its placeholders: half a cast with the
 * other half boxes is worse than either.
 */

import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import { NoColorSpace, SRGBColorSpace, Texture, type Material, type Mesh, type MeshStandardMaterial } from "three/webgpu"
import { readGlb, unpack, type Slot } from "./glb"
import { releaseAfterUpload } from "./upload-release"
import { BODIES, animationsUrl, glbUrl, templateOf, type Body, type Cast, type Loaded, type Template } from "./rig"

export interface AssetDeps {
  fetchBytes(url: string): Promise<ArrayBuffer>
  /** A PNG as a texture, in the colour space its use needs; without it the materials keep their plain colours (a test). */
  decode?(png: Uint8Array, srgb: boolean): Promise<Texture>
  /**
   * A picture that could not be decoded (the KTX2 transcoder did not start, a file is damaged) does not fail the
   * model: it keeps its plain colour, and this is told once per file.
   */
  warn?(message: string): void
}

export interface CastDeps extends AssetDeps {
  /** The address of the assets folder, with its final slash. */
  base: string
  /** `assets`' level folder: `bassa`, `media` or `alta`. */
  level: string
}

/** The texture a PNG makes: sRGB for a colour, plain numbers for anything else; not flipped (glTF's own convention). */
export async function decodePicture(png: Uint8Array, srgb = true): Promise<Texture> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  })
  const texture = new Texture(bitmap)
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace
  texture.flipY = false
  texture.needsUpdate = true
  return texture
}

function parse(loader: GLTFLoader, buffer: ArrayBuffer): Promise<Loaded> {
  return new Promise((resolve, reject) => loader.parse(buffer, "", (gltf) => resolve(gltf), reject))
}

const newLoader = () => {
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  return loader
}

/** Fetches, unpacks and parses one file, and puts its pictures on its materials. */
export async function loadFile(loader: GLTFLoader, deps: AssetDeps, url: string): Promise<Loaded> {
  const bytes = await deps.fetchBytes(url).catch((error) => {
    throw new Error(`${url}: ${String(error?.message ?? error)}`)
  })
  const { buffer, pictures } = unpack(readGlb(new Uint8Array(bytes)))
  const loaded = await parse(loader, buffer)
  if (deps.decode) {
    const decode = deps.decode
    const seen = new Set<Material>()
    const jobs: Array<Promise<void>> = []
    const failed = new Set<string>()
    loaded.scene.traverse((o) => {
      const material = (o as Mesh).material as MeshStandardMaterial | undefined
      if (!material || seen.has(material)) return
      seen.add(material)
      const own = pictures.get(material.name)
      if (!own) return
      const put = async (slot: Slot) => {
        const png = own[slot]
        if (!png) return
        const texture = await decode(png, slot === "map").catch((error) => {
          failed.add(String(error?.message ?? error).slice(0, 120))
        })
        if (!texture) return
        // Once the GPU has it, the CPU's copy goes (`upload-release.ts`).
        releaseAfterUpload(texture)
        if (slot === "map") material.map = texture
        else if (slot === "normalMap") material.normalMap = texture
        else {
          // The packed picture is occlusion in red, roughness in green and metalness in blue: one texture for all three.
          material.aoMap = texture
          material.roughnessMap = texture
          material.metalnessMap = texture
        }
        material.needsUpdate = true
      }
      for (const slot of ["map", "normalMap", "ormMap"] as const) jobs.push(put(slot))
    })
    await Promise.all(jobs)
    if (failed.size) deps.warn?.(`${url}: texture non decodificate (${[...failed].join("; ")}): tinte unite`)
  }
  return loaded
}

export async function loadCast(deps: CastDeps): Promise<Cast> {
  const loader = newLoader()
  // The clips come once, from their own file; the bodies bring only mesh, skeleton and anchors.
  const [{ animations }, ...bodies] = await Promise.all([
    loadFile(loader, deps, animationsUrl(deps.base)),
    ...BODIES.map(async (body: Body) => [body, await loadFile(loader, deps, glbUrl(deps.base, deps.level, body))] as const),
  ] as const)
  const templates = (bodies as unknown as Array<readonly [Body, Loaded]>).map(([body, loaded]): Template => templateOf(body, loaded, animations))
  return new Map(templates.map((t) => [t.body, t]))
}

/** The city's own file at a level: the shop, the plaza, the lamps. */
export const cityUrl = (base: string, level: string) => `${base}levels/${level}/city.glb`

export async function loadCityFile(deps: CastDeps): Promise<Loaded> {
  return loadFile(newLoader(), deps, cityUrl(deps.base, deps.level))
}
