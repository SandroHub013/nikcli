/**
 * What a chiringuito coming up out of the sand throws around it: a ring of disturbed sand on the ground and puffs of
 * sand dust along its sides, strongest half way up and gone when it is up (or down). Drawn only while it moves.
 *
 * The group is in the shop's own frame, at the ground: `view.ts` puts it in the shop's group and holds it at the
 * ground while the shop itself is still under it.
 */

import {
  BufferGeometry,
  Color,
  DataTexture,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RGBAFormat,
  RingGeometry,
  UnsignedByteType,
  Vector3,
} from "three/webgpu"

/** The ring of sand: inside it is the chiringuito, outside the beach it pushed. */
export const RISE_RING = { inner: 3.4, outer: 5.8 }
/** How many puffs of sand along the sides: small, low, running outward. */
export const RISE_PUFFS = 28

const ringGeometry = new RingGeometry(RISE_RING.inner, RISE_RING.outer, 48, 1)

/**
 * The ring's fade, across it: nothing at its inner and outer edge, most a third of the way out. The ring's UVs are
 * its plane's, (0.5, 0.5) at the middle, so the alpha is a picture of that profile around the centre.
 */
function ringFade(size = 64): DataTexture {
  const data = new Uint8Array(size * size * 4)
  const outer = RISE_RING.outer
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5) * 2 * outer
      const t = (r - RISE_RING.inner) / (outer - RISE_RING.inner)
      const a = t <= 0 || t >= 1 ? 0 : t < 0.35 ? Math.sin((t / 0.35) * (Math.PI / 2)) : Math.cos(((t - 0.35) / 0.65) * (Math.PI / 2))
      data.fill(Math.round(255 * a * a), (y * size + x) * 4, (y * size + x) * 4 + 4)
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType)
  texture.magFilter = texture.minFilter = LinearFilter
  texture.needsUpdate = true
  return texture
}
const fade = ringFade()

/**
 * A puff of dust: a low dome of radius 1 whose alpha, in its vertices' colour, goes from most at the middle to nothing
 * at the rim. Soft at the edge from wherever it is seen, so it reads as dust over the sand and not as a pebble on it.
 */
function dustGeometry(segments = 10): BufferGeometry {
  const rings = [
    { r: 0, y: 1, a: 0.85 },
    { r: 0.5, y: 0.75, a: 0.5 },
    { r: 1, y: 0, a: 0 },
  ]
  const position: number[] = []
  const color: number[] = []
  const index: number[] = []
  position.push(0, rings[0].y, 0)
  color.push(1, 1, 1, rings[0].a)
  for (const ring of rings.slice(1)) {
    for (let k = 0; k < segments; k++) {
      const a = (k / segments) * Math.PI * 2
      position.push(Math.cos(a) * ring.r, ring.y, Math.sin(a) * ring.r)
      color.push(1, 1, 1, ring.a)
    }
  }
  for (let k = 0; k < segments; k++) {
    const next = (k + 1) % segments
    index.push(0, 1 + next, 1 + k)
    const [a, b, c, d] = [1 + k, 1 + next, 1 + segments + k, 1 + segments + next]
    index.push(a, b, d, a, d, c)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3))
  geometry.setAttribute("color", new Float32BufferAttribute(color, 4))
  geometry.setIndex(index)
  geometry.computeBoundingSphere()
  return geometry
}
const puffGeometry = dustGeometry()
const UP = new Vector3(0, 1, 0)

export interface RiseFx {
  group: Group
  ring: Mesh
  puffs: InstancedMesh
  /** Shapes the ring and the puffs for a shop `lift` of the way up (0..1). */
  update(lift: number): void
  dispose(): void
}

/** How strong the effect is at `lift`: nothing down or up, all of it half way. */
export const riseStrength = (lift: number): number => (lift <= 0 || lift >= 1 ? 0 : Math.sin(Math.PI * lift))

export function createRiseFx(): RiseFx {
  const group = new Group()
  group.name = "rise"
  // The alpha map is read from its green channel: the picture is grey, the same in every channel.
  const ringMaterial = new MeshBasicMaterial({ color: new Color(0xc9a77c), alphaMap: fade, transparent: true, opacity: 0, depthWrite: false })
  const ring = new Mesh(ringGeometry, ringMaterial)
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.04
  // Sand, not smoke: the beach's own colour, a little lighter where it is thrown up.
  const puffMaterial = new MeshBasicMaterial({ color: new Color(0xd2b58a), vertexColors: true, transparent: true, opacity: 0, depthWrite: false })
  const puffs = new InstancedMesh(puffGeometry, puffMaterial, RISE_PUFFS)
  group.add(ring, puffs)
  group.visible = false

  // Where each puff starts along the chiringuito's sides, and how it differs from the others: fixed, not random per frame.
  const seeds = Array.from({ length: RISE_PUFFS }, (_, i) => {
    const a = (i / RISE_PUFFS) * Math.PI * 2 + 0.17 * Math.sin(i * 2.3)
    return { a, k: 0.5 + 0.5 * Math.sin(i * 5.1 + 1.3) }
  })
  const matrix = new Matrix4()
  const at = new Vector3()
  const size = new Vector3()
  const turn = new Quaternion()

  return {
    group,
    ring,
    puffs,
    update(lift) {
      const s = riseStrength(lift)
      group.visible = s > 0.01
      if (!group.visible) return
      ringMaterial.opacity = 0.7 * s
      ring.scale.setScalar(0.85 + 0.3 * lift)
      puffMaterial.opacity = 0.6 * s
      for (const [i, { a, k }] of seeds.entries()) {
        // Each runs outward along the ground, lifts a hand off it, and spreads thinner as it goes.
        const run = lift * (0.7 + 0.6 * k)
        const out = 3.2 + 2.6 * run
        at.set(Math.sin(a) * out, 0.03 + 0.12 * Math.sin(Math.PI * Math.min(1, run)), Math.cos(a) * out * 0.9)
        const r = (0.16 + 0.22 * run) * (0.7 + 0.6 * k)
        size.set(r * 1.5, r * 0.4, r)
        // Long along the way it runs.
        turn.setFromAxisAngle(UP, a - Math.PI / 2)
        matrix.compose(at, turn, size)
        puffs.setMatrixAt(i, matrix)
      }
      puffs.instanceMatrix.needsUpdate = true
    },
    dispose() {
      ringMaterial.dispose()
      puffMaterial.dispose()
      puffs.dispose()
    },
  }
}
