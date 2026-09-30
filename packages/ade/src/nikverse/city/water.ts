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
 * moving ripples that calm down with the distance, and a band of foam runs along the shore.
 *
 * What stands over the water is reflected without a reflection pass: the reflected ray of each pixel is tested
 * against a few vertical columns of light, the hologram (cyan) and the lit front of each chiringuito (warm). A ray
 * that passes near a column, at a height where the column shines, picks up its colour; the ripples stretch it into
 * a streak.
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
  Vector4,
} from "three/webgpu"
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  dot,
  exp,
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
  /** The hologram's light on the water, and a chiringuito's lamps (3000 K). */
  holo: 0x38d8ff,
  lamp: 0xffc98a,
} as const

/** How many chiringuiti the water reflects: the first ring's slots. */
export const REFLECTED_SHOPS = 12

/** The columns of light the water reflects: where they stand, how wide they are, between which heights they shine. */
const HOLOGRAM_COLUMN = { x: 0, z: 0, width: 1.1, from: 1.8, to: 6.8, strength: 0.55 }
const SHOP_COLUMN = { width: 2.4, from: 0.5, to: 3.2, strength: 0.35 }

/** The shore band's foam, off on the lowest level. */
export interface WaterOptions {
  foam?: boolean
}

/** A chiringuito the water reflects: where it stands, and how much of it is up (0 under the sand, 1 open). */
export interface ReflectedShop {
  x: number
  z: number
  up: number
}

export interface IslandPaint {
  /** How many meshes were painted. */
  painted: number
  /** Moves the ripples and the foam to the world's time `t` (seconds), and the dome with the camera. */
  update(t: number, camera?: { position: { x: number; z: number } }): void
  /** The chiringuiti whose lights the water reflects (the first `REFLECTED_SHOPS`). */
  shops(list: ReadonlyArray<ReflectedShop>): void
}

const linear = (hex: number) => new Color(hex)

// ------------------------------------------------------------------ TSL

type Vec3Node = ReturnType<typeof vec3>
type FloatNode = ReturnType<typeof float>

const waterTime = uniform(0)
/** Each chiringuito as (x, z, how much it shines, unused). */
const shopLights = Array.from({ length: REFLECTED_SHOPS }, () => uniform(new Vector4()))

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

/** How much a ray from `p` along `r` sees of a vertical column of light at (cx, cz) (see the header). */
function columnNode(p: Vec3Node, r: Vec3Node, cx: FloatNode, cz: FloatNode, column: { width: number; from: number; to: number }): FloatNode {
  const along = vec2(r.x, r.z)
  const to = vec2(cx, cz).sub(vec2(p.x, p.z))
  const t = max(dot(to, along).div(max(dot(along, along), 1e-5)), 0)
  const miss = length(vec2(p.x, p.z).add(along.mul(t)).sub(vec2(cx, cz))).div(column.width)
  const y = p.y.add(r.y.mul(t))
  const within = smoothstep(column.from - 0.5, column.from, y).mul(float(1).sub(smoothstep(column.to, column.to + 1, y)))
  return exp(miss.mul(miss).negate()).mul(within) as unknown as FloatNode
}

function waterNodeMaterial(foamOn: boolean): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ fog: true })
  const light = attribute("color", "vec3") as unknown as Vec3Node
  const depth = light.x.mul(8)
  const shore = light.y
  const p = positionWorld as unknown as Vec3Node
  const t = waterTime
  // The ripples calm down with the distance: at the horizon they would only be a grid of aliasing.
  const calm = float(1).sub(smoothstep(15, 60, length(cameraPosition.sub(p))))
  const nx = sin(p.x.mul(1.7).add(p.z.mul(0.6)).add(t.mul(1.1))).mul(0.035).add(sin(p.z.mul(3.1).sub(t.mul(1.7))).mul(0.02)).mul(calm)
  const nz = sin(p.z.mul(1.3).sub(p.x.mul(0.8)).add(t.mul(0.9))).mul(0.035).add(sin(p.x.mul(2.7).add(t.mul(1.4))).mul(0.02)).mul(calm)
  const n = normalize(vec3(nx, 1, nz))
  const view = normalize(cameraPosition.sub(p))
  const facing = clamp(dot(n, view), 0, 1)
  const fresnel = float(0.02).add(pow(float(1).sub(facing), 5).mul(0.98))
  const r = reflect(view.negate(), n) as unknown as Vec3Node
  const sky = skyNode(normalize(vec3(r.x, abs(r.y), r.z)) as unknown as Vec3Node)
  const tinted = mix(tone(DUSK.sand), tone(DUSK.lagoon), smoothstep(0, 0.25, depth).mul(0.7).add(0.3))
  // The lagoon a third greyer than its teal: the turquoise stays the hologram's.
  const shallow = mix(tinted, vec3(dot(tinted, vec3(0.2126, 0.7152, 0.0722))), 0.3)
  const body = mix(shallow, tone(DUSK.deep), smoothstep(0.5, 3, depth))
  let color = mix(body, sky, fresnel)
  // The columns of light: brighter where the fresnel is, never gone where it is not.
  const reflecting = fresnel.mul(0.8).add(0.2)
  const holo = columnNode(p, r, float(HOLOGRAM_COLUMN.x) as unknown as FloatNode, float(HOLOGRAM_COLUMN.z) as unknown as FloatNode, HOLOGRAM_COLUMN)
  color = color.add(tone(DUSK.holo).mul(holo.mul(HOLOGRAM_COLUMN.strength).mul(reflecting)))
  let lamps = float(0) as unknown as FloatNode
  for (const shop of shopLights) {
    const node = shop as unknown as { x: FloatNode; y: FloatNode; z: FloatNode }
    lamps = lamps.add(columnNode(p, r, node.x, node.y, SHOP_COLUMN).mul(node.z)) as unknown as FloatNode
  }
  color = color.add(tone(DUSK.lamp).mul(lamps.mul(SHOP_COLUMN.strength).mul(reflecting)))
  if (foamOn) {
    // A thin band, broken along the shore: two slow waves across it leave gaps.
    const band = sin(shore.mul(10).sub(t.mul(1.3))).mul(0.5).add(0.5)
    const breaks = smoothstep(-0.2, 0.5, sin(p.x.mul(0.9).add(t.mul(0.4))).mul(sin(p.z.mul(1.1).sub(t.mul(0.3)))).add(0.2))
    const foam = clamp(shore.mul(shore).mul(smoothstep(0.55, 0.95, band).mul(0.7).add(shore.mul(0.3))).mul(breaks), 0, 1)
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

const num = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`)

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
      uHolo: { value: linear(DUSK.holo) },
      uLamp: { value: linear(DUSK.lamp) },
      uShops: { value: Array.from({ length: REFLECTED_SHOPS }, () => new Vector4()) },
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
uniform vec3 uHolo;
uniform vec3 uLamp;
uniform vec4 uShops[${REFLECTED_SHOPS}];
uniform float uTime;
varying vec3 vWorld;
varying vec3 vLight;
float nkvColumn(vec3 p, vec3 r, vec2 c, float width, float from, float to) {
  vec2 along = r.xz;
  float t = max(dot(c - p.xz, along) / max(dot(along, along), 1e-5), 0.0);
  float miss = length(p.xz + along * t - c) / width;
  float y = p.y + r.y * t;
  return exp(-miss * miss) * smoothstep(from - 0.5, from, y) * (1.0 - smoothstep(to, to + 1.0, y));
}
void main() {
  float depth = vLight.x * 8.0;
  float shore = vLight.y;
  vec3 p = vWorld;
  float t = uTime;
  float calm = 1.0 - smoothstep(15.0, 60.0, length(cameraPosition - p));
  float nx = (sin(p.x * 1.7 + p.z * 0.6 + t * 1.1) * 0.035 + sin(p.z * 3.1 - t * 1.7) * 0.02) * calm;
  float nz = (sin(p.z * 1.3 - p.x * 0.8 + t * 0.9) * 0.035 + sin(p.x * 2.7 + t * 1.4) * 0.02) * calm;
  vec3 n = normalize(vec3(nx, 1.0, nz));
  vec3 v = normalize(cameraPosition - p);
  float fresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
  vec3 r = reflect(-v, n);
  vec3 sky = nkvSky(normalize(vec3(r.x, abs(r.y), r.z)));
  vec3 tinted = mix(uSand, uLagoon, smoothstep(0.0, 0.25, depth) * 0.7 + 0.3);
  vec3 shallow = mix(tinted, vec3(dot(tinted, vec3(0.2126, 0.7152, 0.0722))), 0.3);
  vec3 body = mix(shallow, uDeep, smoothstep(0.5, 3.0, depth));
  vec3 color = mix(body, sky, fresnel);
  float reflecting = fresnel * 0.8 + 0.2;
  color += uHolo * nkvColumn(p, r, vec2(${num(HOLOGRAM_COLUMN.x)}, ${num(HOLOGRAM_COLUMN.z)}), ${num(HOLOGRAM_COLUMN.width)}, ${num(HOLOGRAM_COLUMN.from)}, ${num(HOLOGRAM_COLUMN.to)}) * ${num(HOLOGRAM_COLUMN.strength)} * reflecting;
  float lamps = 0.0;
  for (int i = 0; i < ${REFLECTED_SHOPS}; i++) {
    lamps += nkvColumn(p, r, uShops[i].xy, ${num(SHOP_COLUMN.width)}, ${num(SHOP_COLUMN.from)}, ${num(SHOP_COLUMN.to)}) * uShops[i].z;
  }
  color += uLamp * lamps * ${num(SHOP_COLUMN.strength)} * reflecting;
#ifdef NKV_FOAM
  float band = sin(shore * 10.0 - t * 1.3) * 0.5 + 0.5;
  float breaks = smoothstep(-0.2, 0.5, sin(p.x * 0.9 + t * 0.4) * sin(p.z * 1.1 - t * 0.3) + 0.2);
  float foam = clamp(shore * shore * (smoothstep(0.55, 0.95, band) * 0.7 + shore * 0.3) * breaks, 0.0, 1.0);
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
    shops(list) {
      for (let i = 0; i < REFLECTED_SHOPS; i++) {
        const shop = list[i]
        const value = shop ? [shop.x, shop.z, Math.max(0, Math.min(1, shop.up)), 0] : [0, 0, 0, 0]
        shopLights[i].value.set(value[0], value[1], value[2], value[3])
        // Only the water's shader has them; the sky's does not.
        for (const s of shaders) (s.uniforms.uShops?.value as Vector4[] | undefined)?.[i].set(value[0], value[1], value[2], value[3])
      }
    },
  }
}
