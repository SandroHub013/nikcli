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
