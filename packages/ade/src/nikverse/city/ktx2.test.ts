import { describe, expect, test } from "bun:test"
import { RGB_S3TC_DXT1_Format, SRGBColorSpace, Texture, type CompressedTexture } from "three/webgpu"
import { bc1Ktx2 } from "./fixtures/make-ktx2"
import { imageSizes, readGlb, unpack, type Glb } from "./glb"
import { createPictureDecoder, type Ktx2Support } from "./ktx2"
import { isKtx2, ktx2Size } from "./ktx2-header"

const fixture = bc1Ktx2(8, 8)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe("KTX2 files", () => {
  test("they are known by their first twelve bytes and their size is in the header", () => {
    expect(isKtx2(fixture)).toBe(true)
    expect(ktx2Size(fixture)).toEqual({ width: 8, height: 8 })
    expect(isKtx2(PNG)).toBe(false)
    expect(isKtx2(new Uint8Array(3))).toBe(false)
    expect(() => ktx2Size(PNG)).toThrow("not a ktx2")
  })
})

describe("the decoder of pictures", () => {
  const renderer = { extensions: { has: () => false, get: () => undefined } } as unknown as Ktx2Support

  test("a PNG goes the plain way and the KTX2 loader is never made for it", async () => {
    const seen: Array<[number, boolean]> = []
    const texture = new Texture()
    const decoder = createPictureDecoder(renderer, async (bytes, srgb) => {
      seen.push([bytes.length, srgb])
      return texture
    })
    expect(await decoder.decode(PNG, true)).toBe(texture)
    expect(await decoder.decode(PNG, false)).toBe(texture)
    expect(seen).toEqual([
      [PNG.length, true],
      [PNG.length, false],
    ])
    decoder.dispose()
  })

  test("a KTX2 file in the GPU's own format is read as it is: no transcoder, no worker, and its colour space is its own", async () => {
    let plain = 0
    const decoder = createPictureDecoder(renderer, async () => {
      plain++
      return new Texture()
    })
    const texture = (await decoder.decode(fixture, false)) as CompressedTexture
    expect(plain).toBe(0)
    expect(texture.isCompressedTexture).toBe(true)
    expect(texture.format).toBe(RGB_S3TC_DXT1_Format)
    expect([texture.image.width, texture.image.height]).toEqual([8, 8])
    expect(texture.mipmaps).toHaveLength(1)
    // The file says sRGB; the `srgb: false` given for a PNG does not override it.
    expect(texture.colorSpace).toBe(SRGBColorSpace)
    decoder.dispose()
    // Disposing twice, or before anything was decoded, is harmless.
    decoder.dispose()
  })

  test("the bytes handed in are not emptied by the loader that takes a copy", async () => {
    const before = fixture.length
    const decoder = createPictureDecoder(renderer)
    await decoder.decode(fixture, true)
    expect(fixture.length).toBe(before)
    expect(isKtx2(fixture)).toBe(true)
    decoder.dispose()
  })

  test("a KTX2 file that is not in a GPU format (Basis, which needs its transcoder) is refused, not waited for", async () => {
    // vkFormat 0 is «undefined»: the file says a transcoder must make the pixels. The world has none (it would need eval).
    const basis = bc1Ktx2(8, 8)
    new DataView(basis.buffer, basis.byteOffset).setUint32(12, 0, true)
    const decoder = createPictureDecoder(renderer)
    const outcome = await Promise.race([decoder.decode(basis, true).then(() => "decoded", () => "refused"), new Promise((r) => setTimeout(() => r("waited"), 3000))])
    expect(outcome).not.toBe("decoded")
    decoder.dispose()
  })
})

/** A `.glb` with one material whose colour and normals are KTX2 pictures, the way the generator will pack them. */
function ktx2Glb(): Glb {
  const bin = new Uint8Array(64)
  bin.set(fixture.subarray(0, 32), 0)
  bin.set(fixture.subarray(0, 32), 32)
  return {
    bin,
    json: {
      asset: { version: "2.0" },
      extensionsUsed: ["EXT_meshopt_compression", "KHR_texture_basisu"],
      extensionsRequired: ["EXT_meshopt_compression", "KHR_texture_basisu"],
      bufferViews: [
        { byteOffset: 0, byteLength: 32 },
        { byteOffset: 32, byteLength: 32 },
      ],
      images: [
        { bufferView: 0, mimeType: "image/ktx2" },
        { bufferView: 1, mimeType: "image/ktx2" },
      ],
      textures: [
        { extensions: { KHR_texture_basisu: { source: 0 } } },
        { extensions: { KHR_texture_basisu: { source: 1 } } },
      ],
      materials: [{ name: "wall", pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } }],
    } as Glb["json"],
  }
}

describe("unpacking a file with KTX2 pictures", () => {
  test("the pictures come out by material and slot, and the loader is not told to expect the KTX2 extension", () => {
    const { buffer, pictures } = unpack(ktx2Glb())
    const own = pictures.get("wall")!
    expect(Object.keys(own).sort()).toEqual(["map", "normalMap"])
    expect(isKtx2(own.map!)).toBe(true)
    const after = readGlb(new Uint8Array(buffer)).json
    expect(after.extensionsRequired).toEqual(["EXT_meshopt_compression"])
    expect(after.extensionsUsed).toEqual(["EXT_meshopt_compression"])
    expect(after.textures).toBeUndefined()
    expect(after.images).toBeUndefined()
  })

  test("a file whose only extension was the KTX2 one has no extension list left, not an empty one", () => {
    const glb = ktx2Glb()
    glb.json.extensionsUsed = ["KHR_texture_basisu"]
    glb.json.extensionsRequired = ["KHR_texture_basisu"]
    const after = readGlb(new Uint8Array(unpack(glb).buffer)).json
    expect(after.extensionsUsed).toBeUndefined()
    expect(after.extensionsRequired).toBeUndefined()
  })

  test("the size of a KTX2 picture inside a file is read from its header, like a PNG's", () => {
    expect(imageSizes(ktx2Glb())).toEqual([
      { width: 8, height: 8 },
      { width: 8, height: 8 },
    ])
  })
})
