/**
 * Pictures on the GPU: KTX2 through three's own loader, and PNG for what is not KTX2 (yet).
 *
 * The KTX2 the generator ships is already in the GPU's own format (BC1 and BC7 through s3tc and bptc on a PC),
 * supercompressed with zstd if at all. three's loader reads such a file on the main thread, the zstd in
 * WebAssembly (which the world's policy allows): no transcoder, no worker, no `blob:` in the policy. A KTX2
 * that needs transcoding (Basis) is not handled: the transcoder is built with Embind, which evaluates strings,
 * and the world's scripts may not (`script-src` has no `'unsafe-eval'`); such a file fails to decode, and the
 * model keeps its plain colours (`assets.ts`).
 */

import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js"
import type { CompressedTexture, Texture } from "three/webgpu"
import { decodePicture } from "./assets"
import { isKtx2 } from "./ktx2-header"

export interface PictureDecoder {
  /** A picture as a texture: KTX2 by its header, PNG otherwise. `srgb` is for PNG; a KTX2 file says its own colour space. */
  decode(bytes: Uint8Array, srgb: boolean): Promise<Texture>
  dispose(): void
}

/** What the loader needs of a renderer: the classic one's extensions, or the WebGPU one's features. */
export type Ktx2Support = Parameters<KTX2Loader["detectSupport"]>[0]

export function createPictureDecoder(renderer: Ktx2Support, png: PictureDecoder["decode"] = decodePicture): PictureDecoder {
  let loader: KTX2Loader | undefined
  return {
    decode(bytes, srgb) {
      if (!isKtx2(bytes)) return png(bytes, srgb)
      loader ??= new KTX2Loader().detectSupport(renderer)
      // A copy: the loader takes the buffer it is given.
      const copy = bytes.slice().buffer
      return new Promise<CompressedTexture>((resolve, reject) => loader!.parse(copy, resolve, reject))
    },
    dispose() {
      loader?.dispose()
      loader = undefined
    },
  }
}
