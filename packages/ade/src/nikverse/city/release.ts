/**
 * Giving the GPU's memory back the moment the world goes: the scene's geometries, materials and textures, then
 * the renderer, and with it the device.
 *
 * A frame that is unloaded keeps its process for a while, and the GPU process keeps what the frame allocated
 * until that process is collected: minutes. Nothing here is left for the collector: every resource is disposed
 * by hand, and the WebGPU device is destroyed (three's own `dispose()` does not do that; a WebGL context is
 * given up with `forceContextLoss`).
 */

import type { BufferGeometry, InstancedMesh, Material, Object3D, SkinnedMesh, Texture } from "three/webgpu"
import type { DrawingSurface } from "./renderers"

export interface Released {
  geometries: number
  materials: number
  textures: number
}

const isTexture = (value: unknown): value is Texture => Boolean(value && (value as Texture).isTexture)

/** Every texture a material holds: `map`, `normalMap`, `lightMap`, `aoMap`... whatever property is one. */
function texturesOf(material: Material): Texture[] {
  return Object.values(material).filter(isTexture)
}

/** Disposes everything under `root` once, however many meshes share it. Returns how much there was. */
export function disposeTree(root: Object3D): Released {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const textures = new Set<Texture>()
  root.traverse((node) => {
    const mesh = node as Partial<SkinnedMesh> & { geometry?: BufferGeometry; material?: Material | Material[] }
    if (mesh.geometry) geometries.add(mesh.geometry)
    for (const material of [mesh.material].flat()) {
      if (!material) continue
      materials.add(material)
      for (const texture of texturesOf(material)) textures.add(texture)
    }
    mesh.skeleton?.dispose()
    // An instanced mesh's matrices and colours are buffers of their own, which only its `dispose` gives back.
    if ((node as InstancedMesh).isInstancedMesh) (node as InstancedMesh).dispose()
  })
  for (const texture of textures) {
    // A decoded picture is an `ImageBitmap`, which holds its pixels until it is closed.
    ;(texture.image as { close?: () => void } | undefined)?.close?.()
    texture.dispose()
  }
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
  return { geometries: geometries.size, materials: materials.size, textures: textures.size }
}

interface Releasable extends DrawingSurface {
  /** three's WebGPU renderer: its backend holds the `GPUDevice`. */
  backend?: { device?: { destroy?: () => void } }
  /** three's WebGL renderer. */
  forceContextLoss?: () => void
}

/** Disposes the renderer and gives the device or the context up. */
export function releaseRenderer(renderer: DrawingSurface): void {
  const surface = renderer as Releasable
  surface.dispose()
  surface.backend?.device?.destroy?.()
  surface.forceContextLoss?.()
}
