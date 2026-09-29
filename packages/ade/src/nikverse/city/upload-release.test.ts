import { describe, expect, test } from "bun:test"
import { CompressedTexture, Texture } from "three/webgpu"
import { releaseAfterUpload, releaseImage } from "./upload-release"

const bitmap = (width: number, height: number) => {
  const state = { closed: false }
  return { width, height, state, close: () => void (state.closed = true) }
}

describe("the CPU copy of an uploaded picture", () => {
  test("a bitmap is closed and the texture keeps its size, which is what three reads of a texture it does not update", () => {
    const image = bitmap(1024, 512)
    const texture = new Texture(image as never)
    expect(releaseImage(texture)).toBe(true)
    expect(image.state.closed).toBe(true)
    expect(texture.image as unknown).toEqual({ width: 1024, height: 512 })
    // Nothing is left to free the second time.
    expect(releaseImage(texture)).toBe(false)
  })

  test("the bytes of a compressed texture's levels go, and their sizes and their number stay", () => {
    const texture = new CompressedTexture(
      [
        { data: new Uint8Array(1000), width: 8, height: 8 },
        { data: new Uint8Array(250), width: 4, height: 4 },
      ] as never,
      8,
      8,
    )
    expect(releaseImage(texture)).toBe(true)
    expect(texture.mipmaps).toHaveLength(2)
    expect(texture.mipmaps.map((m) => [m.width, m.height, (m.data as Uint8Array).byteLength])).toEqual([
      [8, 8, 0],
      [4, 4, 0],
    ])
    expect(releaseImage(texture)).toBe(false)
  })

  test("a texture that holds nothing of the kind is left as it is", () => {
    const texture = new Texture({ width: 4, height: 4, data: new Uint8Array(64) } as never)
    expect(releaseImage(texture)).toBe(false)
    expect((texture.image as { data: Uint8Array }).data.byteLength).toBe(64)
  })

  test("nothing is freed before the upload: only three's own callback does it, and a callback that was there still runs", () => {
    const image = bitmap(8, 8)
    const texture = new Texture(image as never)
    const seen: string[] = []
    texture.onUpdate = () => void seen.push("before")
    releaseAfterUpload(texture)
    expect(image.state.closed).toBe(false)
    texture.onUpdate(texture)
    expect(seen).toEqual(["before"])
    expect(image.state.closed).toBe(true)
  })
})
