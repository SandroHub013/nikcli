/**
 * What a frame draws, part by part: the bench's split of the renderer's triangles and draw calls, so that a shot over
 * the ceiling says where the weight is. It counts what the renderer would draw from that camera: the meshes that are
 * visible, whose sphere is in the view (or that are never culled), each mesh a draw call for each of its materials and
 * its triangles times its instances.
 */

import { Frustum, InstancedMesh, Matrix4, type Camera, type Mesh, type Object3D } from "three/webgpu"

/** The parts the bench names; what is none of them is `rest`. */
export const DRAWN_PARTS = ["veg_lod0", "veg_lod1", "palms", "terrain", "water", "shops", "people", "sky", "rest"] as const
export type DrawnPart = (typeof DRAWN_PARTS)[number]
export type DrawnSplit = Record<DrawnPart, { triangles: number; calls: number }>

/** The part a mesh is in: by its own name for the island's pieces, by the group it hangs from for the rest. */
export function drawnPart(mesh: Object3D): DrawnPart {
  const name = mesh.name
  // By the detail it is drawn with: a near plant seen from afar has the far one's pieces (`kit.plantDetail`).
  if (name.startsWith("veg_lod1") || (name.startsWith("veg_") && name.endsWith("_far"))) return "veg_lod1"
  if (name.startsWith("veg_lod0")) return "veg_lod0"
  if (name.startsWith("veg_palm")) return "palms"
  // The terrain has the canopy beyond the plantations in it: one mesh.
  if (name.startsWith("island_terrain")) return "terrain"
  if (name.startsWith("island_water")) return "water"
  if (name.startsWith("island_sky") || name.startsWith("island_stars")) return "sky"
  for (let o: Object3D | null = mesh.parent; o; o = o.parent) {
    if (o.name === "people") return "people"
    if (o.name.startsWith("shop:")) return "shops"
  }
  return "rest"
}

/** The plan's ceilings for one frame: the scene's triangles and draw calls, and the plants' triangles (palms too). */
export const DRAWN_CEILINGS = { triangles: 600_000, calls: 150, vegetation: 200_000 }

/** What a frame's counts break of the ceilings, in words for the bench's report. */
export function drawnOver(drawn: { calls: number; triangles: number } | undefined, split: DrawnSplit | undefined): string[] {
  const over: string[] = []
  if (drawn && drawn.triangles > DRAWN_CEILINGS.triangles) over.push(`${drawn.triangles} triangles over ${DRAWN_CEILINGS.triangles}`)
  if (drawn && drawn.calls > DRAWN_CEILINGS.calls) over.push(`${drawn.calls} draw calls over ${DRAWN_CEILINGS.calls}`)
  const plants = split ? split.veg_lod0.triangles + split.veg_lod1.triangles + split.palms.triangles : 0
  if (plants > DRAWN_CEILINGS.vegetation) over.push(`${plants} plant triangles over ${DRAWN_CEILINGS.vegetation}`)
  return over
}

const shown = (o: Object3D): boolean => {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false
  return true
}

export function drawnSplit(scene: Object3D, camera: Camera): DrawnSplit {
  const split = Object.fromEntries(DRAWN_PARTS.map((p) => [p, { triangles: 0, calls: 0 }])) as DrawnSplit
  scene.updateMatrixWorld()
  camera.updateMatrixWorld()
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  )
  scene.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh || !shown(mesh)) return
    if (mesh.frustumCulled && !frustum.intersectsObject(mesh)) return
    const g = mesh.geometry
    const count = g.index ? g.index.count : (g.getAttribute("position")?.count ?? 0)
    const range = Math.min(count, g.drawRange.count) - g.drawRange.start
    const instances = mesh instanceof InstancedMesh ? mesh.count : 1
    if (instances === 0 || range <= 0) return
    const part = split[drawnPart(mesh)]
    part.triangles += Math.floor(range / 3) * instances
    part.calls += Array.isArray(mesh.material) ? Math.max(1, g.groups.length) : 1
  })
  return split
}
