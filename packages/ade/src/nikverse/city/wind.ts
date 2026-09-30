/**
 * The wind in the island's plants: a sway of a few centimetres, more at the top than at the foot, a phase of its
 * own for each plant. In the vertex shader, so it costs nothing on the CPU; it moves only when the world draws,
 * and when the quiet loop stops drawing the plants stand still with the sea.
 *
 * On WebGPU the plants get a node material with the sway in its `positionNode` (the instance is already placed:
 * the height is read from the geometry as the file has it); on WebGL the same sway goes into the shader's
 * `begin_vertex`, before the instance's matrix. Either way the plants get materials of their own: the kit's are
 * shared with the rocks and the chiringuiti, which do not sway.
 */

import { type InstancedMesh, type Material, MeshBasicMaterial, MeshBasicNodeMaterial, type Object3D } from "three/webgpu"
import { float, instanceIndex, positionGeometry, positionLocal, sin, uniform, vec3 } from "three/tsl"
import type { HologramKind } from "./hologram"

/** How far a plant's top moves (metres, at scale 1). */
export const WIND_SWAY = 0.03
/** The height over which the sway grows from nothing (the foot) to all of it (metres, the prototype's). */
export const WIND_HEIGHT = 2.2
/** How fast it sways (radians a second). */
export const WIND_SPEED = 1.4

export interface Wind {
  /** Moves the wind to the world's time `t` (seconds). */
  update(t: number): void
  /** The meshes that sway. */
  meshes: InstancedMesh[]
}

const swaying = (o: Object3D): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh === true && o.name.startsWith("veg_")

/** The kit's own material of a plant, before the wind: a kit shared by two scenes of two kinds is swayed again from it. */
const original = new WeakMap<InstancedMesh, Material>()

/** Gives the plants under `root` their wind, for this kind of renderer. */
export function plantWind(root: Object3D, kind: HologramKind): Wind {
  const meshes: InstancedMesh[] = []
  root.traverse((o) => {
    if (swaying(o)) meshes.push(o)
  })
  const time = uniform(0)
  const glsl = { value: 0 }
  const made = new Map<Material, Material>()
  for (const mesh of meshes) {
    if (!original.has(mesh)) original.set(mesh, mesh.material as Material)
    mesh.userData.nkv_wind = kind
    const source = original.get(mesh) as MeshBasicMaterial
    let material = made.get(source)
    if (!material) {
      material = kind === "tsl" ? nodeWind(source, time) : shaderWind(source, glsl)
      made.set(source, material)
    }
    mesh.material = material
  }
  return {
    meshes,
    update(t) {
      time.value = t
      glsl.value = t
    },
  }
}

function nodeWind(source: MeshBasicMaterial, time: ReturnType<typeof uniform>): Material {
  const material = new MeshBasicNodeMaterial()
  material.copy(source as unknown as MeshBasicNodeMaterial)
  const up = positionGeometry.y.div(WIND_HEIGHT).clamp(0, 1)
  const phase = float(instanceIndex).mul(1.7)
  const sway = sin((time as unknown as ReturnType<typeof float>).mul(WIND_SPEED).add(phase)).mul(WIND_SWAY).mul(up.mul(up))
  material.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.6)))
  return material
}

function shaderWind(source: MeshBasicMaterial, time: { value: number }): Material {
  const material = source.clone()
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = time
    shader.vertexShader = `uniform float uWindTime;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
  float windUp = clamp(position.y / ${WIND_HEIGHT.toFixed(2)}, 0.0, 1.0);
  float windSway = sin(uWindTime * ${WIND_SPEED.toFixed(2)} + float(gl_InstanceID) * 1.7) * ${WIND_SWAY.toFixed(3)} * windUp * windUp;
  transformed += vec3(windSway, 0.0, windSway * 0.6);`,
    )
  }
  material.customProgramCacheKey = () => "nkv-wind"
  return material
}
