import { describe, expect, test } from "bun:test"
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, SkinnedMesh, Texture } from "three/webgpu"
import { disposeTree, releaseRenderer } from "./release"
import type { DrawingSurface } from "./renderers"

/** Counts the `dispose` calls of an object without changing what it does. */
function spy<T extends { dispose(): void }>(thing: T): T & { disposed: number } {
  const counted = thing as T & { disposed: number }
  counted.disposed = 0
  const original = thing.dispose.bind(thing)
  thing.dispose = () => {
    counted.disposed++
    original()
  }
  return counted
}

describe("giving the scene back", () => {
  test("every geometry, material and texture under the root is disposed, once, however many meshes share it", () => {
    const geometry = spy(new BoxGeometry())
    const map = spy(new Texture())
    const normal = spy(new Texture())
    const light = spy(new Texture())
    const shared = spy(new MeshStandardMaterial({ map, normalMap: normal, lightMap: light }))
    const plain = spy(new MeshBasicMaterial({ color: 0xff0000 }))
    const root = new Group()
    const inner = new Group()
    inner.add(new Mesh(geometry, shared), new Mesh(geometry, shared))
    root.add(inner, new Mesh(new BoxGeometry(), plain))
    const released = disposeTree(root)
    expect(released).toEqual({ geometries: 2, materials: 2, textures: 3 })
    for (const thing of [geometry, shared, plain, map, normal, light]) expect(thing.disposed).toBe(1)
  })

  test("a material given as a list is disposed piece by piece, and a group with nothing to draw costs nothing", () => {
    const a = spy(new MeshBasicMaterial())
    const b = spy(new MeshBasicMaterial())
    const root = new Group()
    root.add(new Mesh(new BoxGeometry(), [a, b]), new Group())
    expect(disposeTree(root)).toEqual({ geometries: 1, materials: 2, textures: 0 })
    expect([a.disposed, b.disposed]).toEqual([1, 1])
  })

  test("a decoded picture is closed as well: an ImageBitmap holds its pixels until it is", () => {
    let closed = 0
    const texture = new Texture({ close: () => void closed++ } as unknown as ImageBitmap)
    const root = new Group()
    root.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ map: texture })))
    disposeTree(root)
    expect(closed).toBe(1)
  })

  test("a skinned mesh gives its skeleton back", () => {
    let skeletons = 0
    const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial()) as unknown as SkinnedMesh
    mesh.skeleton = { dispose: () => void skeletons++ } as unknown as SkinnedMesh["skeleton"]
    const root = new Group()
    root.add(mesh)
    disposeTree(root)
    expect(skeletons).toBe(1)
  })
})

describe("giving the renderer back", () => {
  const surface = (extra: Record<string, unknown> = {}) => {
    const calls: string[] = []
    const renderer = { dispose: () => void calls.push("dispose"), ...extra } as unknown as DrawingSurface
    return { renderer, calls }
  }

  test("WebGPU: the renderer is disposed and the device destroyed, in that order", () => {
    const { renderer, calls } = surface({ backend: { device: { destroy: () => void calls.push("destroy") } } })
    releaseRenderer(renderer)
    expect(calls).toEqual(["dispose", "destroy"])
  })

  test("WebGL: the renderer is disposed and the context given up", () => {
    const { renderer, calls } = surface({ forceContextLoss: () => void calls.push("context-loss") })
    releaseRenderer(renderer)
    expect(calls).toEqual(["dispose", "context-loss"])
  })

  test("a renderer with neither is only disposed", () => {
    const { renderer, calls } = surface()
    releaseRenderer(renderer)
    expect(calls).toEqual(["dispose"])
  })
})
