import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { chooseRenderer, type DrawingSurface, type RendererDeps } from "./renderers"

interface FakeCanvas {
  id: number
}

/** A renderer that only says which it is. */
const surface = (name: string): DrawingSurface & { name: string } => ({
  name,
  render() {},
  setSize() {},
  setPixelRatio() {},
  setClearColor() {},
  dispose() {},
  toneMapping: 0,
})

function rig(over: Partial<RendererDeps<FakeCanvas>> = {}) {
  const made: FakeCanvas[] = []
  const calls: string[] = []
  const deps: RendererDeps<FakeCanvas> = {
    makeCanvas: () => {
      const canvas = { id: made.length + 1 }
      made.push(canvas)
      return canvas
    },
    gpu: { requestAdapter: async () => ({}) },
    options: { antialias: true, alpha: false },
    createWebGPU: async (canvas) => {
      calls.push(`webgpu:${canvas.id}`)
      return surface("webgpu")
    },
    createClassic: (canvas) => {
      calls.push(`classic:${canvas.id}`)
      return surface("classic")
    },
    ...over,
  }
  return { deps, made, calls }
}

describe("which renderer draws the city", () => {
  test("with WebGPU in the frame it is WebGPURenderer", async () => {
    const { deps, calls } = rig()
    const chosen = await chooseRenderer(deps)
    expect(chosen.backend).toBe("webgpu")
    expect((chosen.renderer as { name?: string }).name).toBe("webgpu")
    expect(calls).toEqual(["webgpu:1"])
    expect(chosen.why).toBeUndefined()
  })

  test("without WebGPU it is the classic WebGL renderer, and WebGPURenderer is not even tried", async () => {
    const { deps, calls } = rig({ gpu: undefined })
    const chosen = await chooseRenderer(deps)
    expect([chosen.backend, (chosen.renderer as { name?: string }).name]).toEqual(["webgl2", "classic"])
    expect(calls).toEqual(["classic:1"])
    expect(chosen.why).toContain("non disponibile")
  })

  test("a WebGPU that gives no adapter, or throws asking for one, is the same: the classic renderer", async () => {
    const none = await chooseRenderer(rig({ gpu: { requestAdapter: async () => null } }).deps)
    expect(none.backend).toBe("webgl2")
    expect(none.why).toContain("adattatore")
    const throws = rig({
      gpu: {
        requestAdapter: async () => {
          throw new Error("blocked")
        },
      },
    })
    const chosen = await chooseRenderer(throws.deps)
    expect(chosen.backend).toBe("webgl2")
    expect(chosen.why).toContain("blocked")
    expect(throws.calls).toEqual(["classic:1"])
  })

  test("a WebGPU start that fails is retried on a fresh canvas: the first one already holds a webgpu context", async () => {
    const { deps, calls, made } = rig({
      createWebGPU: async (canvas) => {
        calls2.push(canvas.id)
        throw new Error("device lost")
      },
    })
    const calls2: number[] = []
    const chosen = await chooseRenderer(deps)
    expect(chosen.backend).toBe("webgl2")
    expect(calls2).toEqual([1])
    expect(calls).toEqual(["classic:2"])
    expect(chosen.canvas).toBe(made[1])
    expect(chosen.canvas).not.toBe(made[0])
    expect(chosen.why).toContain("device lost")
  })

  test("the classic renderer can be asked for even where WebGPU exists, to compare the two", async () => {
    const { deps, calls } = rig({ classic: true })
    const chosen = await chooseRenderer(deps)
    expect(chosen.backend).toBe("webgl2")
    expect(calls).toEqual(["classic:1"])
  })

  test("WebGPURenderer is started with a canvas and the options and nothing that would pick its WebGL backend", async () => {
    let seen: unknown
    const { deps } = rig({
      createWebGPU: async (canvas, options) => {
        seen = { canvas, options }
        return surface("webgpu")
      },
    })
    await chooseRenderer(deps)
    expect(seen).toEqual({ canvas: { id: 1 }, options: { antialias: true, alpha: false } })
  })
})

describe("lint: what the budget forbids", () => {
  const dir = import.meta.dir
  const sources = () =>
    [...new Bun.Glob("*.ts").scanSync(dir)]
      .filter((f) => !f.endsWith(".test.ts"))
      .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const)
      .concat([["world.js", readFileSync(join(dir, "..", "world", "world.js"), "utf8")]])

  test("no source forces the WebGL backend of WebGPURenderer or turns on dynamic shadows", () => {
    for (const [file, text] of sources()) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      expect([file, /forceWebGL/.test(code)]).toEqual([file, false])
      expect([file, /shadowMap|castShadow\s*=\s*true|receiveShadow\s*=\s*true/.test(code)]).toEqual([file, false])
    }
  })

  test("node materials (TSL) are used by the hologram and by nothing else", () => {
    const users = sources()
      .filter(([, text]) => /three\/tsl|NodeMaterial/.test(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")))
      .map(([file]) => file)
    expect(users.sort()).toEqual(["hologram.ts"])
  })
})
