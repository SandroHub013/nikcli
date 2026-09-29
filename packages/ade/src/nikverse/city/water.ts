/**
 * The island's lagoon and sky: the two meshes of `city.glb` the file does not colour itself (`nkv_shade` `water`
 * and `sky`), painted here with one sky function, so the sea reflects the same dusk the dome shows.
 *
 * The sky: indigo at the zenith, violet halfway down, a mauve horizon to the north and the glow of the sun that set
 * ten minutes ago to the south (+z, behind the first look).
 *
 * The water is one opaque mesh: no reflection pass, no refraction. The file puts in its vertex colours how deep
 * the water is (red, depth / 8 m) and how near the shore (green, 1 at the waterline): the colour goes from the sand
 * seen through a few centimetres to the lagoon's teal to the deep blue, the sky comes in by fresnel off small
 * moving ripples, and a band of foam runs along the shore.
 *
 * Node materials (TSL) on WebGPU, the same look as plain shaders on the classic WebGL renderer.
 */

import {
  Color,
  DoubleSide,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  type Object3D,
  ShaderMaterial,
} from "three/webgpu"
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  dot,
  float,
  length,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from "three/tsl"
import type { HologramKind } from "./hologram"

/** The dusk's colours, sRGB as the plan gives them. */
export const DUSK = {
  zenith: 0x1b1f3a,
  mid: 0x5a3f7a,
  horizon: 0x6a5a8c,
  glow: 0xff8a5b,
  glowHigh: 0xf2a97f,
  deep: 0x10243f,
  lagoon: 0x1e5a66,
  /** The lagoon's floor seen through a few centimetres of water, in the dusk light. */
  sand: 0x6f6454,
  foam: 0xf4e9dc,
} as const

/** The shore band's foam, off on the lowest level. */
export interface WaterOptions {
  foam?: boolean
}

export interface IslandPaint {
  /** How many meshes were painted. */
  painted: number
  /** Moves the ripples and the foam to the world's time `t` (seconds), and the dome with the camera. */
  update(t: number, camera?: { position: { x: number; z: number } }): void
}

const linear = (hex: number) => new Color(hex)

// ------------------------------------------------------------------ TSL

type Vec3Node = ReturnType<typeof vec3>
type FloatNode = ReturnType<typeof float>

const waterTime = uniform(0)

/** A colour of the dusk as a constant of the node graph (linear, like the scene's colours). */
const tone = (hex: number) => uniform(new Color(hex)) as unknown as Vec3Node

/** The dusk sky seen along direction `d` (normalised, world axes). */
function skyNode(d: Vec3Node): Vec3Node {
  const h = clamp(d.y, 0, 1) as unknown as FloatNode
  const up = mix(tone(DUSK.horizon), tone(DUSK.mid), smoothstep(0, 0.3, h))
  const high = mix(up, tone(DUSK.zenith), smoothstep(0.3, 0.9, h))
  const south = d.z.div(max(length(vec2(d.x, d.z)), 1e-4))
  const glow = pow(max(south, 0), 3).mul(float(1).sub(smoothstep(0, 0.35, h)))
  const glowColor = mix(tone(DUSK.glow), tone(DUSK.glowHigh), smoothstep(0, 0.2, h))
  return mix(high, glowColor, glow) as unknown as Vec3Node
}

function skyNodeMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ side: DoubleSide, fog: false, depthWrite: false })
  material.colorNode = skyNode(normalize(positionWorld.sub(cameraPosition)) as unknown as Vec3Node)
  return material
}

function waterNodeMaterial(foamOn: boolean): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ fog: true })
  const light = attribute("color", "vec3") as unknown as Vec3Node
  const depth = light.x.mul(8)
  const shore = light.y
  const p = positionWorld
  const t = waterTime
  const nx = sin(p.x.mul(1.7).add(p.z.mul(0.6)).add(t.mul(1.1))).mul(0.035).add(sin(p.z.mul(3.1).sub(t.mul(1.7))).mul(0.02))
  const nz = sin(p.z.mul(1.3).sub(p.x.mul(0.8)).add(t.mul(0.9))).mul(0.035).add(sin(p.x.mul(2.7).add(t.mul(1.4))).mul(0.02))
  const n = normalize(vec3(nx, 1, nz))
  const view = normalize(cameraPosition.sub(p))
  const facing = clamp(dot(n, view), 0, 1)
  const fresnel = float(0.02).add(pow(float(1).sub(facing), 5).mul(0.98))
  const r = reflect(view.negate(), n)
  const sky = skyNode(normalize(vec3(r.x, abs(r.y), r.z)) as unknown as Vec3Node)
  const shallow = mix(tone(DUSK.sand), tone(DUSK.lagoon), smoothstep(0, 0.25, depth).mul(0.7).add(0.3))
  const body = mix(shallow, tone(DUSK.deep), smoothstep(0.5, 3, depth))
  let color = mix(body, sky, fresnel)
  if (foamOn) {
    const band = sin(shore.mul(10).sub(t.mul(1.3))).mul(0.5).add(0.5)
    const foam = clamp(shore.mul(smoothstep(0.5, 0.95, band).mul(0.6).add(shore.mul(0.4))), 0, 1)
    color = mix(color, tone(DUSK.foam), foam.mul(0.85))
  }
  material.colorNode = color
  return material
}

// ------------------------------------------------------------------ GLSL

const SKY_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uGlowHigh;
vec3 nkvSky(vec3 d) {
  float h = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(uHorizon, uMid, smoothstep(0.0, 0.3, h));
  c = mix(c, uZenith, smoothstep(0.3, 0.9, h));
  float south = d.z / max(length(d.xz), 1e-4);
  float glow = pow(max(south, 0.0), 3.0) * (1.0 - smoothstep(0.0, 0.35, h));
  return mix(c, mix(uGlow, uGlowHigh, smoothstep(0.0, 0.2, h)), glow);
}
`

const skyUniforms = () => ({
  uZenith: { value: linear(DUSK.zenith) },
  uMid: { value: linear(DUSK.mid) },
  uHorizon: { value: linear(DUSK.horizon) },
  uGlow: { value: linear(DUSK.glow) },
  uGlowHigh: { value: linear(DUSK.glowHigh) },
})

function skyShaderMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: skyUniforms(),
    vertexShader: /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`,
    fragmentShader: /* glsl */ `
${SKY_GLSL}
varying vec3 vWorld;
void main() {
  gl_FragColor = vec4(nkvSky(normalize(vWorld - cameraPosition)), 1.0);
  #include <colorspace_fragment>
}`,
    side: DoubleSide,
    depthWrite: false,
  })
}

function waterShaderMaterial(foamOn: boolean): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      // The renderer fills these from the scene's fog (`fog: true`).
      fogColor: { value: new Color() },
      fogNear: { value: 1 },
      fogFar: { value: 2000 },
      fogDensity: { value: 0.00025 },
      ...skyUniforms(),
      uDeep: { value: linear(DUSK.deep) },
      uLagoon: { value: linear(DUSK.lagoon) },
      uSand: { value: linear(DUSK.sand) },
      uFoam: { value: linear(DUSK.foam) },
      uTime: { value: 0 },
    },
    defines: foamOn ? { NKV_FOAM: 1 } : {},
    vertexColors: true,
    fog: true,
    vertexShader: /* glsl */ `
#include <fog_pars_vertex>
varying vec3 vWorld;
varying vec3 vLight;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vLight = color.rgb;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: /* glsl */ `
${SKY_GLSL}
#include <fog_pars_fragment>
uniform vec3 uDeep;
uniform vec3 uLagoon;
uniform vec3 uSand;
uniform vec3 uFoam;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vLight;
void main() {
  float depth = vLight.x * 8.0;
  float shore = vLight.y;
  vec3 p = vWorld;
  float t = uTime;
  float nx = sin(p.x * 1.7 + p.z * 0.6 + t * 1.1) * 0.035 + sin(p.z * 3.1 - t * 1.7) * 0.02;
  float nz = sin(p.z * 1.3 - p.x * 0.8 + t * 0.9) * 0.035 + sin(p.x * 2.7 + t * 1.4) * 0.02;
  vec3 n = normalize(vec3(nx, 1.0, nz));
  vec3 v = normalize(cameraPosition - p);
  float fresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
  vec3 r = reflect(-v, n);
  vec3 sky = nkvSky(normalize(vec3(r.x, abs(r.y), r.z)));
  vec3 shallow = mix(uSand, uLagoon, smoothstep(0.0, 0.25, depth) * 0.7 + 0.3);
  vec3 body = mix(shallow, uDeep, smoothstep(0.5, 3.0, depth));
  vec3 color = mix(body, sky, fresnel);
#ifdef NKV_FOAM
  float band = sin(shore * 10.0 - t * 1.3) * 0.5 + 0.5;
  float foam = clamp(shore * (smoothstep(0.5, 0.95, band) * 0.6 + shore * 0.4), 0.0, 1.0);
  color = mix(color, uFoam, foam * 0.85);
#endif
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
  })
}

// ------------------------------------------------------------------ the island's meshes

/** Gives the file's `water` and `sky` meshes under `root` their materials. */
export function paintIsland(root: Object3D, kind: HologramKind, options: WaterOptions = {}): IslandPaint {
  const foam = options.foam ?? true
  const made = new Map<string, Material>()
  const shaders: ShaderMaterial[] = []
  const domes: Mesh[] = []
  let painted = 0
  root.traverse((o) => {
    const mesh = o as Mesh
    const shade = mesh.userData?.nkv_shade
    // The stars hang on the dome: they go with it.
    if (mesh.isMesh && mesh.name.startsWith("island_stars")) domes.push(mesh)
    if (!mesh.isMesh || (shade !== "water" && shade !== "sky")) return
    let material = made.get(shade)
    if (!material) {
      if (kind === "tsl") material = shade === "water" ? waterNodeMaterial(foam) : skyNodeMaterial()
      else {
        const shader = shade === "water" ? waterShaderMaterial(foam) : skyShaderMaterial()
        shaders.push(shader)
        material = shader
      }
      made.set(shade, material)
    }
    ;(mesh.material as Material).dispose?.()
    mesh.material = material
    // The dome is drawn first, behind everything; the sea is plain opaque ground.
    if (shade === "sky") {
      mesh.renderOrder = -1
      domes.push(mesh)
    }
    painted++
  })
  return {
    painted,
    update(t, camera) {
      waterTime.value = t
      // The dome (r 360) goes where the camera goes: seen from the aerial shot its far side would be past the far plane.
      if (camera) for (const d of domes) d.position.set(camera.position.x, 0, camera.position.z)
      for (const s of shaders) if (s.uniforms.uTime) s.uniforms.uTime.value = t
    },
  }
}
