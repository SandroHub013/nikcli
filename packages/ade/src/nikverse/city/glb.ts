/**
 * What can be read from a `.glb` without decoding it: its JSON header and the size of the images inside.
 *
 * The assets are meshopt-compressed, so the geometry is not read here (that is the loader's job in the
 * world), but every accessor keeps its count, which is all a triangle budget needs. Used by the tests,
 * which check the shipped files against the generator's ceilings.
 */

import { isKtx2, ktx2Refusal, ktx2Size } from "./ktx2-header"

/**
 * The extension the pictures of a KTX2 file are declared under. It is ours and it is required: the file says «this is a KTX2
 * already in the GPU's format (BC, plain or zstd)», which `KHR_texture_basisu` does not (that one means Basis, and needs a
 * transcoder the world cannot run). A viewer that does not know it must refuse the file, not show it without textures.
 */
export const KTX2_EXTENSION = "NIKVERSE_texture_ktx2"

/** What a glb may not say: the Khronos name for Basis. A file that declares it is refused whatever its pictures are. */
const BASIS_EXTENSION = "KHR_texture_basisu"

export interface GltfJson {
  asset?: { version?: string }
  extensionsUsed?: string[]
  extensionsRequired?: string[]
  scenes?: Array<{ nodes?: number[] }>
  nodes?: Array<{ name?: string; mesh?: number; skin?: number; children?: number[]; translation?: number[] }>
  meshes?: Array<{ name?: string; primitives: Array<{ indices?: number; attributes: Record<string, number>; material?: number }> }>
  accessors?: Array<{ count: number }>
  buffers?: Array<{ byteLength: number }>
  bufferViews?: Array<{ byteOffset?: number; byteLength: number }>
  images?: Array<{ bufferView?: number; uri?: string; mimeType?: string; name?: string }>
  textures?: Array<{ source?: number; sampler?: number; extensions?: { NIKVERSE_texture_ktx2?: { source?: number }; KHR_texture_basisu?: { source?: number } } }>
  materials?: unknown[]
  animations?: Array<{ name?: string; channels: unknown[] }>
  skins?: unknown[]
}

export interface Glb {
  json: GltfJson
  bin: Uint8Array
}

const MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

export function readGlb(bytes: Uint8Array): Glb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== MAGIC) throw new Error("not a glb")
  if (view.getUint32(4, true) !== 2) throw new Error("glb version is not 2")
  let json: GltfJson | undefined
  let bin: Uint8Array = new Uint8Array(0)
  for (let at = 12; at + 8 <= bytes.byteLength; ) {
    const length = view.getUint32(at, true)
    const type = view.getUint32(at + 4, true)
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === JSON_CHUNK) json = JSON.parse(new TextDecoder().decode(body))
    else if (type === BIN_CHUNK) bin = body
    at += 8 + length
  }
  if (!json) throw new Error("glb without a JSON chunk")
  return { json, bin }
}

/** The width and height of a PNG from its header. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const signature = [0x89, 0x50, 0x4e, 0x47]
  if (bytes.byteLength < 24 || signature.some((b, i) => bytes[i] !== b)) throw new Error("not a png")
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** The size of every image embedded in the file, in the order of `images`. */
export function imageSizes(glb: Glb): Array<{ width: number; height: number }> {
  return (glb.json.images ?? []).map((image) => {
    if (image.bufferView === undefined) throw new Error(`image ${image.name ?? "?"} is not embedded`)
    const view = glb.json.bufferViews?.[image.bufferView]
    if (!view) throw new Error(`image ${image.name ?? "?"} points at no buffer view`)
    const start = view.byteOffset ?? 0
    const bytes = glb.bin.subarray(start, start + view.byteLength)
    return image.mimeType === "image/ktx2" ? ktx2Size(bytes) : pngSize(bytes)
  })
}

/** The triangles of the mesh a node draws (its own, not its children's). */
export function trianglesOf(glb: Glb, node: number): number {
  const mesh = glb.json.nodes?.[node]?.mesh
  if (mesh === undefined) return 0
  let total = 0
  for (const primitive of glb.json.meshes?.[mesh]?.primitives ?? []) {
    const accessor = primitive.indices ?? primitive.attributes.POSITION
    total += Math.floor((glb.json.accessors?.[accessor]?.count ?? 0) / 3)
  }
  return total
}

/** The index of the node with this name, or -1. */
export const nodeNamed = (glb: Glb, name: string): number => (glb.json.nodes ?? []).findIndex((n) => n.name === name)

/** Every node under `node`, itself included. */
export function subtree(glb: Glb, node: number): number[] {
  const out = [node]
  for (const child of glb.json.nodes?.[node]?.children ?? []) out.push(...subtree(glb, child))
  return out
}

/** Whether the parts every LOD wears (hat, helmet, cape) are drawn at this LOD: not at the farthest, where the body alone is. */
export const wearsAccessories = (lod: 0 | 1 | 2): boolean => lod < 2

/** The triangles drawn for a person at one LOD: the skinned body at that level, and the accessories where they are worn. */
export function characterTriangles(glb: Glb, lod: 0 | 1 | 2): number {
  const nodes = glb.json.nodes ?? []
  const named = nodes.findIndex((n) => n.name?.endsWith(`_lod${lod}`))
  if (named < 0) return 0
  const others = nodes.flatMap((n, i) => (n.mesh !== undefined && n.skin === undefined && !/_lod\d$/.test(n.name ?? "") ? [i] : []))
  return trianglesOf(glb, named) + (wearsAccessories(lod) ? others.reduce((sum, i) => sum + trianglesOf(glb, i), 0) : 0)
}

/** Where on a material a picture goes: the colour, the normals, and the packed occlusion (R), roughness (G) and metalness (B). */
export type Slot = "map" | "normalMap" | "ormMap"

export interface Unpacked {
  /** The same file with its images and textures taken out, for the loader to parse. */
  buffer: ArrayBuffer
  /** The PNGs of each material, by the material's name and the slot they go in. */
  pictures: Map<string, Partial<Record<Slot, Uint8Array>>>
}

/**
 * Takes the embedded pictures out of a file.
 *
 * The loader would read them back through a `blob:` address, and the world's policy lets `fetch` reach
 * its own host and nothing else, so it could not. The world decodes them itself from the bytes instead
 * (`createImageBitmap` on a `Blob` fetches nothing) and puts them on the materials after the parse.
 */
export function unpack(glb: Glb): Unpacked {
  type Ref = { index: number } | undefined
  type Material = {
    name?: string
    normalTexture?: Ref
    occlusionTexture?: Ref
    pbrMetallicRoughness?: { baseColorTexture?: Ref; metallicRoughnessTexture?: Ref }
  }
  const json = structuredClone(glb.json) as GltfJson & { samplers?: unknown; materials?: Material[] }
  const declared = (list: "extensionsUsed" | "extensionsRequired") => glb.json[list] ?? []
  if (declared("extensionsUsed").includes(BASIS_EXTENSION) || declared("extensionsRequired").includes(BASIS_EXTENSION) || glb.json.textures?.some((t) => t.extensions?.KHR_texture_basisu)) {
    throw new Error(`${BASIS_EXTENSION}: the world reads KTX2 files in the GPU's format under ${KTX2_EXTENSION}, not Basis`)
  }
  const usesKtx2 = glb.json.textures?.some((t) => t.extensions?.NIKVERSE_texture_ktx2) ?? false
  if (usesKtx2 && !declared("extensionsRequired").includes(KTX2_EXTENSION)) {
    throw new Error(`${KTX2_EXTENSION} is used and not in extensionsRequired: a reader that does not know it would show the model without its textures`)
  }
  const pictures = new Map<string, Partial<Record<Slot, Uint8Array>>>()
  const pngOf = (ref: Ref): Uint8Array | undefined => {
    if (!ref) return undefined
    // A KTX2 picture is the texture's `NIKVERSE_texture_ktx2` source; a PNG is its plain one.
    const texture = glb.json.textures?.[ref.index]
    const ktx2 = texture?.extensions?.NIKVERSE_texture_ktx2?.source
    const image = glb.json.images?.[ktx2 ?? texture?.source ?? -1]
    const view = image?.bufferView === undefined ? undefined : glb.json.bufferViews?.[image.bufferView]
    const bytes = view ? glb.bin.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength) : undefined
    // What is under our name must be what the name says: BC, plain or zstd. Basis under it would only fail later, in the GPU or the loader.
    if (bytes && ktx2 !== undefined) {
      if (!isKtx2(bytes)) throw new Error(`${KTX2_EXTENSION}: image ${ktx2} is not a KTX2 file`)
      const why = ktx2Refusal(bytes)
      if (why) throw new Error(`${KTX2_EXTENSION}: image ${ktx2}: ${why}`)
    }
    return bytes
  }
  for (const material of json.materials ?? []) {
    const found: Partial<Record<Slot, Uint8Array>> = {}
    const map = pngOf(material.pbrMetallicRoughness?.baseColorTexture)
    const normal = pngOf(material.normalTexture)
    const orm = pngOf(material.pbrMetallicRoughness?.metallicRoughnessTexture) ?? pngOf(material.occlusionTexture)
    if (map) found.map = map
    if (normal) found.normalMap = normal
    if (orm) found.ormMap = orm
    if (material.name && Object.keys(found).length) pictures.set(material.name, found)
    delete material.normalTexture
    delete material.occlusionTexture
    if (material.pbrMetallicRoughness) {
      delete material.pbrMetallicRoughness.baseColorTexture
      delete material.pbrMetallicRoughness.metallicRoughnessTexture
    }
  }
  delete json.images
  delete json.textures
  delete json.samplers
  // The loader is not given our extension (the pictures are put on the materials here, from the bytes): it must not be told to expect it.
  for (const list of ["extensionsUsed", "extensionsRequired"] as const) {
    const left = json[list]?.filter((name) => name !== KTX2_EXTENSION)
    if (left?.length) json[list] = left
    else delete json[list]
  }

  const text = new TextEncoder().encode(JSON.stringify(json))
  const padded = new Uint8Array(text.length + ((4 - (text.length % 4)) % 4)).fill(0x20)
  padded.set(text)
  const total = 12 + 8 + padded.length + 8 + glb.bin.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, padded.length, true)
  view.setUint32(16, JSON_CHUNK, true)
  out.set(padded, 20)
  const at = 20 + padded.length
  view.setUint32(at, glb.bin.length, true)
  view.setUint32(at + 4, BIN_CHUNK, true)
  out.set(glb.bin, at + 8)
  return { buffer: out.buffer, pictures }
}
