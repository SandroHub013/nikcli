/** three ships `ktx-parse` without types; only what `make-ktx2.ts` uses is declared. */
declare module "three/addons/libs/ktx-parse.module.js" {
  interface Sample {
    bitOffset: number
    bitLength: number
    channelType: number
    samplePosition: number[]
    sampleLower: number
    sampleUpper: number
  }
  interface Container {
    vkFormat: number
    typeSize: number
    pixelWidth: number
    pixelHeight: number
    levelCount: number
    levels: Array<{ levelData: Uint8Array; uncompressedByteLength: number }>
    dataFormatDescriptor: Array<{
      colorModel: number
      colorPrimaries: number
      transferFunction: number
      texelBlockDimension: number[]
      bytesPlane: number[]
      samples: Sample[]
    }>
  }
  export const VK_FORMAT_BC1_RGB_SRGB_BLOCK: number
  export function createDefaultContainer(): Container
  export function write(container: Container): Uint8Array
}
