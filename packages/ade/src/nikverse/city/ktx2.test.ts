import { describe, expect, test } from "bun:test"
import { RGB_S3TC_DXT1_Format, SRGBColorSpace, Texture, type CompressedTexture } from "three/webgpu"
import { bc1Ktx2, bc5Ktx2 } from "./fixtures/make-ktx2"
import { KTX2_EXTENSION, imageSizes, readGlb, unpack, type Glb } from "./glb"
import { createPictureDecoder, serveDataWasm, type Ktx2Support } from "./ktx2"
import { isKtx2, ktx2Format, ktx2Refusal, ktx2Size } from "./ktx2-header"

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

/** The fixture with its one level zstd-compressed, as N3's files are: supercompression 2 and the level index saying both sizes. */
function zstdOf(file: Uint8Array): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const at = Number(view.getBigUint64(80, true))
  const size = Number(view.getBigUint64(88, true))
  const packed = Bun.zstdCompressSync(file.subarray(at, at + size))
  const out = new Uint8Array(at + packed.length)
  out.set(file.subarray(0, at))
  out.set(packed, at)
  const edit = new DataView(out.buffer)
  edit.setUint32(44, 2, true)
  edit.setBigUint64(88, BigInt(packed.length), true)
  edit.setBigUint64(96, BigInt(size), true)
  return out
}

describe("the zstd decoder's WebAssembly, under a policy with no data: in connect-src", () => {
  const wasm = "AGFzbQEAAAA="
  const saved = globalThis.fetch
  const noData = ((input: RequestInfo | URL) =>
    typeof input === "string" && input.startsWith("data:") ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(new Response("page"))) as typeof fetch

  test("that one address is answered from its own bytes, and every other fetch goes on to the page's", async () => {
    const scope = { fetch: noData }
    serveDataWasm(scope)
    const served = await scope.fetch(`data:application/wasm;base64,${wasm}`)
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
    expect(served.headers.get("content-type")).toBe("application/wasm")
    expect(await (await scope.fetch("http://nikverse.localhost/assets/x.glb")).text()).toBe("page")
    await expect(scope.fetch("data:text/plain;base64,QQ==")).rejects.toThrow("Failed to fetch")
    // Twice is once: the wrapper is not wrapped again.
    const once = scope.fetch
    serveDataWasm(scope)
    expect(scope.fetch).toBe(once)
  })

  test("a zstd BC1 file decodes with the policy in force", async () => {
    globalThis.fetch = noData
    try {
      const decoder = createPictureDecoder({ extensions: { has: () => false, get: () => undefined } } as unknown as Ktx2Support)
      const texture = (await decoder.decode(zstdOf(fixture), false)) as CompressedTexture
      expect(texture.isCompressedTexture).toBe(true)
      expect(texture.format).toBe(RGB_S3TC_DXT1_Format)
      expect([texture.image.width, texture.image.height]).toEqual([8, 8])
      expect(texture.mipmaps![0].data).toEqual(fixture.subarray(Number(new DataView(fixture.buffer, fixture.byteOffset).getBigUint64(80, true)), fixture.length))
      decoder.dispose()
    } finally {
      globalThis.fetch = saved
    }
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
  // The header is 48 bytes: what is kept of each picture must hold it.
  const bin = new Uint8Array(128)
  bin.set(fixture.subarray(0, 64), 0)
  bin.set(fixture.subarray(0, 64), 64)
  return {
    bin,
    json: {
      asset: { version: "2.0" },
      extensionsUsed: ["EXT_meshopt_compression", KTX2_EXTENSION],
      extensionsRequired: ["EXT_meshopt_compression", KTX2_EXTENSION],
      bufferViews: [
        { byteOffset: 0, byteLength: 64 },
        { byteOffset: 64, byteLength: 64 },
      ],
      images: [
        { bufferView: 0, mimeType: "image/ktx2" },
        { bufferView: 1, mimeType: "image/ktx2" },
      ],
      textures: [
        { extensions: { NIKVERSE_texture_ktx2: { source: 0 } } },
        { extensions: { NIKVERSE_texture_ktx2: { source: 1 } } },
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
    glb.json.extensionsUsed = [KTX2_EXTENSION]
    glb.json.extensionsRequired = [KTX2_EXTENSION]
    const after = readGlb(new Uint8Array(unpack(glb).buffer)).json
    expect(after.extensionsUsed).toBeUndefined()
    expect(after.extensionsRequired).toBeUndefined()
  })

  test("the extension is ours and required: KHR_texture_basisu is refused even when the pictures inside are BC", () => {
    // BC pictures under the Khronos name for Basis: the file lies about what it holds, and another reader would try to transcode it.
    const glb = ktx2Glb()
    glb.json.extensionsUsed = ["KHR_texture_basisu"]
    glb.json.extensionsRequired = ["KHR_texture_basisu"]
    glb.json.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }, { extensions: { KHR_texture_basisu: { source: 1 } } }]
    expect(ktx2Format(fixture).vkFormat).not.toBe(0)
    expect(() => unpack(glb)).toThrow("KHR_texture_basisu")
    // Declared and not used, or used without the declaration: also refused.
    const named = ktx2Glb()
    named.json.extensionsUsed = [...(named.json.extensionsUsed ?? []), "KHR_texture_basisu"]
    expect(() => unpack(named)).toThrow("KHR_texture_basisu")
  })

  test("our extension not in extensionsRequired is refused: a reader that does not know it would show no textures", () => {
    const glb = ktx2Glb()
    glb.json.extensionsRequired = ["EXT_meshopt_compression"]
    expect(() => unpack(glb)).toThrow("extensionsRequired")
  })

  test("Basis, or anything that is not a BC block format, under our name is refused with the reason", () => {
    const basis = bc1Ktx2(8, 8)
    new DataView(basis.buffer, basis.byteOffset).setUint32(12, 0, true)
    expect(ktx2Refusal(basis)).toContain("Basis")
    const etc1s = bc1Ktx2(8, 8)
    new DataView(etc1s.buffer, etc1s.byteOffset).setUint32(44, 1, true)
    expect(ktx2Refusal(etc1s)).toContain("supercompression 1")
    const rgba8 = bc1Ktx2(8, 8)
    new DataView(rgba8.buffer, rgba8.byteOffset).setUint32(12, 37, true)
    expect(ktx2Refusal(rgba8)).toContain("not a BC format")
    for (const bad of [basis, etc1s, rgba8]) {
      const glb = ktx2Glb()
      glb.bin.set(bad.subarray(0, 64), 0)
      expect(() => unpack(glb)).toThrow(KTX2_EXTENSION)
    }
    // A PNG where a KTX2 was declared.
    const png = ktx2Glb()
    png.bin.set(PNG, 0)
    expect(() => unpack(png)).toThrow("not a KTX2 file")
  })

  test("BC1 and BC5 are what the world takes: they are not refused, plain or with zstd", () => {
    expect(ktx2Refusal(bc1Ktx2(8, 8))).toBeUndefined()
    expect(ktx2Refusal(bc5Ktx2(8, 8))).toBeUndefined()
    expect(ktx2Format(bc5Ktx2(8, 8)).vkFormat).toBe(141)
    const zstd = bc5Ktx2(8, 8)
    new DataView(zstd.buffer, zstd.byteOffset).setUint32(44, 2, true)
    expect(ktx2Refusal(zstd)).toBeUndefined()
  })

  test("the size of a KTX2 picture inside a file is read from its header, like a PNG's", () => {
    expect(imageSizes(ktx2Glb())).toEqual([
      { width: 8, height: 8 },
      { width: 8, height: 8 },
    ])
  })
})
