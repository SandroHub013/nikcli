/**
 * The logo in the square, as a hologram, and its plain twin for the check.
 *
 * Both are built from `logoVoxels`, so they are the brand's own squares: an
 * `InstancedMesh` per colour of the file, one box per square. The hologram
 * dresses them in a cyan tint, a fresnel rim, scanlines that climb, a bright
 * edge on every voxel, and a rare short flicker that shifts the colour channels.
 * A projector disc, a cone of light and an additive halo stand under and behind it.
 *
 * Two dressings of the same look. On WebGPU, TSL node materials. On the classic
 * WebGL renderer, which cannot run node materials, an equivalent `ShaderMaterial`
 * for the voxels and plain painted textures for the cone and the halo.
 *
 * `logoCheck` is the same squares with none of that: flat materials in the
 * exact colours of the file, seen from the front, so a picture of it can be
 * compared with the SVG rasterised (`?check=logo`).
 */

import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshBasicNodeMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
} from "three/webgpu"
import {
  abs,
  clamp,
  cameraPosition,
  dot,
  float,
  fract,
  mix,
  min,
  normalWorld,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
} from "three/tsl"
import { LOGO_SCALE, logoVoxels, type Logo, type Voxel } from "./logo"

const unitBox = new BoxGeometry(1, 1, 1)

/** The distinct colours of the voxels, in the order the file first uses them. */
export function voxelColors(voxels: ReadonlyArray<Voxel>): string[] {
  return [...new Set(voxels.map((v) => v.color))]
}

const matrix = new Matrix4()
const noRotation = new Quaternion()

type VoxelMaterial = MeshBasicMaterial | MeshBasicNodeMaterial | MeshStandardMaterial | ShaderMaterial

/** One `InstancedMesh` per colour, one instance per square. `material(color)` dresses each. */
export function voxelMeshes(logo: Logo, material: (color: string) => VoxelMaterial): Group {
  const voxels = logoVoxels(logo)
  const group = new Group()
  group.name = "logo-voxels"
  for (const color of voxelColors(voxels)) {
    const own = voxels.filter((v) => v.color === color)
    const mesh = new InstancedMesh(unitBox, material(color) as MeshBasicMaterial, own.length)
    mesh.name = `logo-${color}`
    mesh.userData.color = color
    own.forEach((v, i) => {
      matrix.compose(new Vector3(v.cx, v.cy, 0), noRotation, new Vector3(v.sx, v.sy, v.sz))
      mesh.setMatrixAt(i, matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    group.add(mesh)
  }
  return group
}

/** How many pixels of the check picture one SVG unit takes. */
export const CHECK_PIXELS_PER_UNIT = 4

/**
 * The logo as the check sees it: flat, front-on, in the exact colours of the file.
 * The picture is `width × 4` by `height × 4` pixels; the camera frames the logo
 * exactly, so one SVG unit is four pixels.
 */
export function logoCheck(logo: Logo): { scene: Scene; camera: OrthographicCamera; width: number; height: number } {
  const scene = new Scene()
  scene.add(voxelMeshes(logo, (color) => new MeshBasicMaterial({ color: new Color(color) })))
  const halfW = (logo.width * LOGO_SCALE) / 2
  const halfH = (logo.height * LOGO_SCALE) / 2
  const camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 50)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  return { scene, camera, width: logo.width * CHECK_PIXELS_PER_UNIT, height: logo.height * CHECK_PIXELS_PER_UNIT }
}

const CYAN = new Color(0x38d8ff)

/** The hologram's node material for one colour of the logo (WebGPU). */
export function hologramMaterial(file: string, brightness: number): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  })
  const tone = uniform(new Color(file))
  const tint = uniform(CYAN)
  const bright = float(brightness)

  const view = normalize(cameraPosition.sub(positionWorld))
  const facing = abs(dot(normalize(normalWorld), view))
  const rim = pow(float(1).sub(facing), 2.2)

  // A short flicker, once every five seconds: 0.15 s of it.
  const glitch = select(fract(time.div(5)).lessThan(0.03), float(1), float(0))
  const shift = glitch.mul(0.9)
  // The typings of `sin` widen a float to a vec4; the value is a float.
  const scan = (offset: Parameters<typeof positionWorld.y.add>[0]) =>
    sin(positionWorld.y.mul(70).sub(time.mul(4)).add(offset)).mul(0.5).add(0.5) as unknown as ReturnType<typeof float>
  const channels = vec3(mix(float(0.55), float(1), scan(shift)), scan(float(0)), mix(float(0.55), float(1), scan(shift.negate())))

  // The rim of each voxel's faces glows: `uv` runs 0..1 across a face.
  const inset = min(min(uv().x, float(1).sub(uv().x)), min(uv().y, float(1).sub(uv().y)))
  const border = smoothstep(float(0.12), float(0), inset)
  const lines = smoothstep(float(0.4), float(0.9), scan(float(0)))

  material.colorNode = tone
    .mul(0.5)
    .add(tint.mul(float(0.5).add(lines.mul(0.5)).add(rim.mul(0.9)).add(border.mul(0.9))).mul(channels))
    .mul(bright)
  material.opacityNode = clamp(float(0.3).add(rim.mul(0.5)).add(border.mul(0.35)), 0, 1)
    .mul(float(0.82).add(scan(float(0)).mul(0.18)))
    .mul(float(1).sub(glitch.mul(0.35)))
  material.positionNode = positionLocal.add(vec3(glitch.mul(0.05).mul(sin(positionLocal.y.mul(35))), 0, 0))
  return material
}

const VOXEL_VERTEX = `
uniform float uTime;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUv;
void main() {
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
    m = modelMatrix * instanceMatrix;
  #endif
  float glitch = 1.0 - step(0.03, fract(uTime / 5.0));
  vec3 p = position + vec3(glitch * 0.05 * sin(position.y * 35.0), 0.0, 0.0);
  vec4 world = m * vec4(p, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(transpose(inverse(mat3(m))) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}`

const VOXEL_FRAGMENT = `
uniform vec3 uTone;
uniform vec3 uTint;
uniform float uBright;
uniform float uTime;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUv;
float scan(float offset) { return 0.5 + 0.5 * sin(vWorld.y * 70.0 - uTime * 4.0 + offset); }
void main() {
  vec3 view = normalize(cameraPosition - vWorld);
  float rim = pow(1.0 - abs(dot(normalize(vNormal), view)), 2.2);
  float glitch = 1.0 - step(0.03, fract(uTime / 5.0));
  float shift = glitch * 0.9;
  vec3 channels = vec3(mix(0.55, 1.0, scan(shift)), scan(0.0), mix(0.55, 1.0, scan(-shift)));
  float inset = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  float border = smoothstep(0.12, 0.0, inset);
  float lines = smoothstep(0.4, 0.9, scan(0.0));
  vec3 color = (uTone * 0.5 + uTint * (0.5 + lines * 0.5 + rim * 0.9 + border * 0.9) * channels) * uBright;
  float alpha = clamp(0.3 + rim * 0.5 + border * 0.35, 0.0, 1.0) * (0.82 + scan(0.0) * 0.18) * (1.0 - glitch * 0.35);
  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>
}`

/**
 * The same look as a plain `ShaderMaterial`, for the classic WebGL renderer: the rim, the climbing
 * scanlines, the lit edge of every voxel and the rare flicker, in GLSL.
 */
export function hologramShaderMaterial(file: string, brightness: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTone: { value: new Color(file) },
      uTint: { value: CYAN.clone() },
      uBright: { value: brightness },
      uTime: { value: 0 },
    },
    vertexShader: VOXEL_VERTEX,
    fragmentShader: VOXEL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  })
}

/** A small canvas painted by `paint`, as a texture; nothing where there is no canvas to paint on (a test). */
function paintedTexture(width: number, height: number, paint: (g: CanvasRenderingContext2D) => void): CanvasTexture | undefined {
  if (typeof document === "undefined") return undefined
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext("2d")
  if (!g) return undefined
  paint(g)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** Which materials dress the hologram: node materials (TSL) on WebGPU, plain shaders and textures on the classic renderer. */
export type HologramKind = "tsl" | "shader"

export interface Hologram {
  group: Group
  /** The logo itself: it turns and bobs. */
  logo: Group
  glow: Mesh
  /** Advances the slow turn and the bob; `t` is the world clock in seconds. */
  update(t: number, camera: PerspectiveCamera): void
}

/** Seconds for one full turn of the logo. */
export const TURN_SECONDS = 40
/** Where the logo floats: its centre, above the projector. */
export const HOLOGRAM_HEIGHT = 3.5

type Halo = MeshBasicNodeMaterial | MeshBasicMaterial

export function createHologram(logo: Logo, kind: HologramKind = "tsl"): Hologram {
  const group = new Group()
  group.name = "hologram"
  const shaders: ShaderMaterial[] = []

  // Projector: a low dark disc with a lit ring.
  const disc = new Mesh(new CylinderGeometry(2.3, 2.5, 0.25, 48), new MeshStandardMaterial({ color: 0x14181f, roughness: 0.5, metalness: 0.6 }))
  disc.position.y = 0.125
  const ring = new Mesh(new RingGeometry(1.7, 2.05, 64), new MeshBasicMaterial({ color: CYAN, side: DoubleSide }))
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.27
  group.add(disc, ring)

  // The cone of light: open, additive, brightest at the projector and gone at the logo.
  let coneMaterial: Halo
  if (kind === "tsl") {
    const node = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide })
    const along = uv().y
    const sweep = sin(positionWorld.y.mul(9).sub(time.mul(2))).mul(0.5).add(0.5)
    node.colorNode = uniform(CYAN)
    node.opacityNode = float(1).sub(along).mul(0.16).mul(float(0.75).add(sweep.mul(0.25)))
    coneMaterial = node
  } else {
    // A vertical fade painted once: no shader, no animation.
    const fade = paintedTexture(4, 64, (g) => {
      const gradient = g.createLinearGradient(0, 0, 0, 64)
      gradient.addColorStop(0, "rgba(56,216,255,0)")
      gradient.addColorStop(1, "rgba(56,216,255,0.2)")
      g.fillStyle = gradient
      g.fillRect(0, 0, 4, 64)
    })
    coneMaterial = new MeshBasicMaterial({
      color: fade ? 0xffffff : CYAN,
      map: fade,
      opacity: fade ? 1 : 0.09,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    })
  }
  const cone = new Mesh(new CylinderGeometry(1.6, 2.05, HOLOGRAM_HEIGHT + 0.8, 48, 1, true), coneMaterial)
  cone.position.y = 0.27 + (HOLOGRAM_HEIGHT + 0.8) / 2
  group.add(cone)

  // A glow behind the logo: the additive halo, a soft disc that always faces the camera.
  let glowMaterial: Halo
  if (kind === "tsl") {
    const node = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending })
    const fromCentre = uv().sub(0.5).length().mul(2)
    node.colorNode = uniform(CYAN)
    node.opacityNode = pow(clamp(float(1).sub(fromCentre), 0, 1), 2.5).mul(0.28)
    glowMaterial = node
  } else {
    const halo = paintedTexture(128, 128, (g) => {
      const gradient = g.createRadialGradient(64, 64, 0, 64, 64, 64)
      gradient.addColorStop(0, "rgba(56,216,255,0.3)")
      gradient.addColorStop(1, "rgba(56,216,255,0)")
      g.fillStyle = gradient
      g.fillRect(0, 0, 128, 128)
    })
    glowMaterial = new MeshBasicMaterial({
      color: halo ? 0xffffff : CYAN,
      map: halo,
      opacity: halo ? 1 : 0.06,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
  }
  const glow = new Mesh(new PlaneGeometry(9, 9), glowMaterial)
  glow.position.y = HOLOGRAM_HEIGHT
  group.add(glow)

  const spun = new Group()
  spun.position.y = HOLOGRAM_HEIGHT
  spun.add(
    voxelMeshes(logo, (color) => {
      const bright = color.toUpperCase() === "#4B4646" ? 0.55 : 1
      if (kind === "tsl") return hologramMaterial(color, bright)
      const shader = hologramShaderMaterial(color, bright)
      shaders.push(shader)
      return shader
    }),
  )
  group.add(spun)

  return {
    group,
    logo: spun,
    glow,
    update(t, camera) {
      spun.rotation.y = (t / TURN_SECONDS) * Math.PI * 2
      spun.rotation.z = Math.sin(t * 0.5) * 0.03
      spun.position.y = HOLOGRAM_HEIGHT + Math.sin(t * 0.8) * 0.07
      glow.quaternion.copy(camera.quaternion)
      for (const shader of shaders) shader.uniforms.uTime.value = t
    },
  }
}
