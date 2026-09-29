/** What can be told of a KTX2 file from its first bytes, with no decoder. */

/** The twelve bytes that open every KTX2 file: «KTX 20», then a line-break check. */
const MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]

export const isKtx2 = (bytes: Uint8Array): boolean => bytes.byteLength >= MAGIC.length && MAGIC.every((b, i) => bytes[i] === b)

/** The width and height in a KTX2 file's header. */
export function ktx2Size(bytes: Uint8Array): { width: number; height: number } {
  if (!isKtx2(bytes) || bytes.byteLength < 28) throw new Error("not a ktx2")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(20, true), height: view.getUint32(24, true) }
}

/** `supercompressionScheme` values: none, BasisLZ (ETC1S, needs the transcoder), zstd. */
const NONE = 0
const ZSTD = 2

/** The block-compressed formats of a PC's GPU that the world reads as they are: BC1, BC3, BC4, BC5 and BC7 (VkFormat numbers). */
const GPU_BLOCK_FORMATS = new Set([131, 132, 133, 134, 137, 138, 139, 140, 141, 142, 145, 146])

/** The `vkFormat` and the supercompression scheme in a KTX2 file's header. */
export function ktx2Format(bytes: Uint8Array): { vkFormat: number; supercompression: number } {
  if (!isKtx2(bytes) || bytes.byteLength < 48) throw new Error("not a ktx2")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { vkFormat: view.getUint32(12, true), supercompression: view.getUint32(44, true) }
}

/**
 * Why a KTX2 file may not be shipped, or `undefined` when it may: the world reads only a GPU's own block format (BC1 to BC7 as
 * listed above), plain or with zstd. `vkFormat` 0 is Basis (UASTC or ETC1S): its pixels are made by a transcoder that needs
 * `new Function`, which the world's policy forbids.
 */
export function ktx2Refusal(bytes: Uint8Array): string | undefined {
  const { vkFormat, supercompression } = ktx2Format(bytes)
  if (vkFormat === 0) return "Basis (UASTC/ETC1S): it needs a transcoder, which needs eval"
  if (!GPU_BLOCK_FORMATS.has(vkFormat)) return `vkFormat ${vkFormat} is not a BC format the world reads (BC1, BC3, BC4, BC5, BC7)`
  if (supercompression !== NONE && supercompression !== ZSTD) return `supercompression ${supercompression} (only none and zstd are read)`
  return undefined
}
