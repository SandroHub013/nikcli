/**
 * Giving the CPU's copy of a picture back once the GPU has its own.
 *
 * three keeps what it uploaded: a PNG as the `ImageBitmap` it was decoded to (its pixels stay until it is closed), a KTX2 as the
 * mipmaps' bytes in the JS heap. The GPU has a full copy after the first upload, and the frame's process holds the second for as
 * long as the world is open: at Media that is the better part of the gap between the frame's memory and its ceiling. `onUpdate` is
 * three's own callback for «this texture has just been uploaded», and it is where the copy goes.
 *
 * What is left in place is what three still asks of a texture that is not being updated: its size, and its levels' sizes and count.
 * The price is that a texture cannot be uploaded a second time: a lost device rebuilds the scene from the files, as it does anyway.
 */

import type { Texture } from "three/webgpu"

interface Closable {
  close?: () => void
}

interface Mip {
  data?: ArrayBufferView
  width: number
  height: number
}

/** Frees the CPU copy of a texture that has been uploaded. Returns whether there was one to free. */
export function releaseImage(texture: Texture): boolean {
  let freed = false
  const image = texture.image as (Closable & { width: number; height: number }) | undefined
  if (image && typeof image.close === "function") {
    const { width, height } = image
    image.close()
    // Closed, a bitmap's size reads 0: three would size the next update from that.
    texture.image = { width, height }
    freed = true
  }
  const mipmaps = (texture as unknown as { mipmaps?: Mip[] }).mipmaps
  if (mipmaps) {
    for (const mip of mipmaps) {
      if (mip.data && mip.data.byteLength > 0) {
        mip.data = new Uint8Array(0)
        freed = true
      }
    }
  }
  return freed
}

/** Has `releaseImage` run after each upload of this texture (three calls `onUpdate` once the GPU has it). */
export function releaseAfterUpload(texture: Texture): Texture {
  const before = texture.onUpdate
  texture.onUpdate = (t) => {
    before?.(t)
    releaseImage(t)
  }
  return texture
}
