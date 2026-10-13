import { describe, expect, test } from "bun:test"
import {
  AdditiveBlending,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from "three/webgpu"
import {
  CHECK_PIXELS_PER_UNIT,
  TURN_SECONDS,
  createHologram,
  hologramMaterial,
  hologramShaderMaterial,
  logoCheck,
  voxelMeshes,
} from "./hologram"
import { LOGO_SCALE, parseLogo, voxelRect, type LogoRect } from "./logo"

const logo = parseLogo()
const order = (a: LogoRect, b: LogoRect) => a.color.localeCompare(b.color) || a.y - b.y || a.x - b.x

/** The squares an instanced mesh draws, read back from its matrices, in SVG units. */
function rectsOf(mesh: InstancedMesh): LogoRect[] {
  const m = new Matrix4()
  const p = new Vector3()
  const q = new Quaternion()
  const s = new Vector3()
  const out: LogoRect[] = []
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m)
    m.decompose(p, q, s)
    out.push(voxelRect(logo, { cx: p.x, cy: p.y, sx: s.x, sy: s.y, sz: s.z, color: String(mesh.userData.color) }, LOGO_SCALE))
  }
  return out
}

const meshesOf = (root: { traverse(fn: (o: unknown) => void): void }) => {
  const found: InstancedMesh[] = []
  root.traverse((o) => {
    if ((o as InstancedMesh).isInstancedMesh) found.push(o as InstancedMesh)
  })
  return found
}

describe("the hologram's geometry is the logo's paths", () => {
  test("the instances are the file's squares one for one: position, size and colour, tolerance 0", () => {
    const meshes = meshesOf(voxelMeshes(logo, (color) => new MeshBasicMaterial({ color })))
    expect(meshes.map((m) => m.count).sort()).toEqual([11, 6])
    const drawn = meshes.flatMap(rectsOf).sort(order)
    expect(drawn).toEqual([...logo.rects].sort(order))
  })

  test("the hologram in the square draws the same squares, dressed in the hologram material", () => {
    const meshes = meshesOf(createHologram(logo).group)
    expect(meshes).toHaveLength(2)
    expect(meshes.flatMap(rectsOf).sort(order)).toEqual([...logo.rects].sort(order))
    for (const mesh of meshes) expect((mesh.material as unknown as { isNodeMaterial?: boolean }).isNodeMaterial).toBe(true)
  })

  test("each voxel is a box a quarter as deep as it is wide", () => {
    const [mesh] = meshesOf(voxelMeshes(logo, (color) => new MeshBasicMaterial({ color })))
    const m = new Matrix4()
    const s = new Vector3()
    mesh.getMatrixAt(0, m)
    m.decompose(new Vector3(), new Quaternion(), s)
    expect(s.z).toBe(s.x * 0.25)
  })
})

describe("?check=logo: the plain logo, flat and front-on", () => {
  test("every voxel is a flat basic material in exactly the colour of its path", () => {
    const { scene } = logoCheck(logo)
    const meshes = meshesOf(scene)
    expect(meshes).toHaveLength(2)
    for (const mesh of meshes) {
      const material = mesh.material as MeshBasicMaterial
      expect((material as unknown as { isNodeMaterial?: boolean }).isNodeMaterial).toBeFalsy()
      expect(material.isMeshBasicMaterial).toBe(true)
      expect(`#${material.color.getHexString().toUpperCase()}`).toBe(mesh.userData.color)
      expect(material.transparent).toBe(false)
      expect(material.wireframe).toBe(false)
    }
  })

  test("it has no effects: no glow, no cone, no projector, nothing but the squares", () => {
    const { scene } = logoCheck(logo)
    const found: string[] = []
    scene.traverse((o) => {
      if (o === scene) return
      const kind = (o as InstancedMesh).isInstancedMesh ? "voxels" : (o as Mesh).isMesh ? "mesh" : o.type
      found.push(kind)
    })
    expect(found.filter((k) => k !== "Group" && k !== "voxels")).toEqual([])
    expect(found.filter((k) => k === "voxels")).toHaveLength(2)
  })

  test("the picture is four pixels per SVG unit, and the camera frames the logo to the pixel", () => {
    const { camera, width, height } = logoCheck(logo)
    expect(CHECK_PIXELS_PER_UNIT).toBe(4)
    expect([width, height]).toEqual([960, 1200])
    expect(camera).toBeInstanceOf(OrthographicCamera)
    expect((camera.right - camera.left) * (1 / LOGO_SCALE)).toBe(240)
    expect((camera.top - camera.bottom) * (1 / LOGO_SCALE)).toBe(300)
    // Front-on: straight down the z axis, not turned, and the logo is not rotated.
    expect([camera.position.x, camera.position.y]).toEqual([0, 0])
    const looks = camera.getWorldDirection(new Vector3())
    expect([looks.x, looks.y, looks.z].map((n) => Math.round(n * 1e9) / 1e9 + 0)).toEqual([0, 0, -1])
    expect(camera.up.toArray()).toEqual([0, 1, 0])
  })
})

describe("the hologram's effects", () => {
  test("the material is a translucent additive node material with the rim, scanline and flicker nodes", () => {
    const material = hologramMaterial("#F1ECEC", 1)
    expect(material.isNodeMaterial).toBe(true)
    expect(material.transparent).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(material.colorNode).toBeDefined()
    expect(material.opacityNode).toBeDefined()
    expect(material.positionNode).toBeDefined()
  })

  test("it turns once in 40 seconds and holds still in front at time 0", () => {
    const holo = createHologram(logo)
    const camera = new PerspectiveCamera()
    expect(TURN_SECONDS).toBe(40)
    holo.update(0, camera)
    expect(holo.logo.rotation.y).toBe(0)
    holo.update(TURN_SECONDS / 2, camera)
    expect(holo.logo.rotation.y).toBeCloseTo(Math.PI, 10)
    holo.update(TURN_SECONDS, camera)
    expect(holo.logo.rotation.y).toBeCloseTo(Math.PI * 2, 10)
  })

  test("the glow always faces the camera", () => {
    const holo = createHologram(logo)
    const camera = new PerspectiveCamera()
    camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 1.2)
    holo.update(3, camera)
    expect(holo.glow.quaternion.equals(camera.quaternion)).toBe(true)
  })

  test("the hologram has a projector, a cone and a glow under and behind the logo", () => {
    const meshes: Mesh[] = []
    createHologram(logo).group.traverse((o) => {
      if ((o as Mesh).isMesh && !(o as InstancedMesh).isInstancedMesh) meshes.push(o as Mesh)
    })
    expect(meshes.map((m) => m.geometry.type).sort()).toEqual(["CylinderGeometry", "CylinderGeometry", "PlaneGeometry", "RingGeometry"])
  })
})

describe("the hologram on the classic renderer", () => {
  const materialsOf = (kind: "tsl" | "shader") => {
    const materials: Array<Record<string, unknown>> = []
    createHologram(logo, kind).group.traverse((o) => {
      const m = (o as Mesh).material as unknown as Record<string, unknown> | undefined
      if (m) materials.push(m)
    })
    return materials
  }

  test("nothing in it is a node material, which the classic renderer cannot run; with WebGPU the light is", () => {
    expect(materialsOf("shader").filter((m) => m.isNodeMaterial)).toEqual([])
    expect(materialsOf("tsl").filter((m) => m.isNodeMaterial).length).toBeGreaterThan(0)
  })

  test("the voxels are shaders, and the cone and the halo are plain additive materials that write no depth", () => {
    const materials = materialsOf("shader")
    expect(materials.filter((m) => m.isShaderMaterial)).toHaveLength(2)
    const plain = materials.filter((m) => m.blending === AdditiveBlending && !m.isShaderMaterial)
    expect(plain).toHaveLength(2)
    for (const m of plain) expect([m.transparent, m.depthWrite]).toEqual([true, false])
  })

  test("the shader has the same look: rim, climbing scanlines, lit edge, flicker; translucent, additive, no depth", () => {
    const material = hologramShaderMaterial("#F1ECEC", 1)
    expect([material.transparent, material.depthWrite, material.blending]).toEqual([true, false, AdditiveBlending])
    const source = material.vertexShader + material.fragmentShader
    for (const piece of ["pow(1.0 - abs(dot(", "uTime * 4.0", "smoothstep(0.12, 0.0, inset)", "fract(uTime / 5.0)", "step(0.03"])
      expect(source).toContain(piece)
    expect(Object.keys(material.uniforms).sort()).toEqual(["uBright", "uTime", "uTint", "uTone"])
  })

  test("it draws instanced boxes, and the colour goes through the output colour space", () => {
    const { vertexShader, fragmentShader } = hologramShaderMaterial("#4B4646", 0.55)
    expect(vertexShader).toContain("#ifdef USE_INSTANCING")
    expect(vertexShader).toContain("modelMatrix * instanceMatrix")
    expect(fragmentShader).toContain("#include <colorspace_fragment>")
  })

  test("the world's clock reaches every voxel shader", () => {
    const holo = createHologram(logo, "shader")
    const times = () => {
      const seen: number[] = []
      holo.group.traverse((o) => {
        const m = (o as Mesh).material as ShaderMaterial | undefined
        if (m?.isShaderMaterial) seen.push(m.uniforms.uTime.value)
      })
      return seen
    }
    expect(times()).toEqual([0, 0])
    holo.update(12.5, new PerspectiveCamera())
    expect(times()).toEqual([12.5, 12.5])
  })

  test("the squares are the same whatever dresses them: the geometry is the logo's", () => {
    const shader = meshesOf(createHologram(logo, "shader").group).flatMap(rectsOf).sort(order)
    expect(shader).toEqual([...logo.rects].sort(order))
  })
})

describe("the hologram's clock", () => {
  // The bench compares two renders of the same world time: nothing may read the renderer's own, moving `time`.
  test("its shaders run on the world's clock, not on TSL's `time` node", async () => {
    const source = await Bun.file(new URL("./hologram.ts", import.meta.url)).text()
    const imported = /import \{[^}]*\} from "three\/tsl"/s.exec(source)?.[0] ?? ""
    expect(imported).not.toMatch(/\btime\b/)
    expect(source).not.toMatch(/\btime\.(?:mul|div|add|sub)\(/)
    expect(source).toContain("holoTime.value = t")
  })
})
