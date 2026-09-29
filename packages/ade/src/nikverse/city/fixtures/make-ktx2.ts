/**
 * A KTX2 file made for the tests and the render check: BC1 (the format s3tc gives a PC's GPU), one level, not
 * supercompressed and already in the GPU's own format, which is what the generator will ship. three's loader reads
 * such a file on the main thread, with no transcoder and no worker.
 */

import { VK_FORMAT_BC1_RGB_SRGB_BLOCK, createDefaultContainer, write } from "three/addons/libs/ktx-parse.module.js"

/** `width` and `height` are in texels and must be multiples of 4 (a BC1 block is 4x4 texels in 8 bytes). */
export function bc1Ktx2(width: number, height: number): Uint8Array {
  const blocks = (width / 4) * (height / 4)
  const container = createDefaultContainer()
  container.vkFormat = VK_FORMAT_BC1_RGB_SRGB_BLOCK
  container.typeSize = 1
  container.pixelWidth = width
  container.pixelHeight = height
  container.levelCount = 1
  // A BC1 block of one solid colour: two equal end points and every texel on the first.
  const level = new Uint8Array(blocks * 8)
  for (let i = 0; i < blocks; i++) level.set([0x1f, 0x00, 0x1f, 0x00, 0, 0, 0, 0], i * 8)
  container.levels = [{ levelData: level, uncompressedByteLength: level.byteLength }]
  const dfd = container.dataFormatDescriptor[0]
  dfd.colorModel = 128 // KHR_DF_MODEL_BC1A
  dfd.colorPrimaries = 1 // BT.709
  dfd.transferFunction = 2 // sRGB
  dfd.texelBlockDimension = [3, 3, 0, 0]
  dfd.bytesPlane = [8, 0, 0, 0, 0, 0, 0, 0]
  dfd.samples = [{ bitOffset: 0, bitLength: 63, channelType: 0, samplePosition: [0, 0, 0, 0], sampleLower: 0, sampleUpper: 0xffffffff }]
  return write(container)
}
