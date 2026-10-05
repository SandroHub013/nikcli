import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { LEVELS_DIR } from "./test-cast"
import { BODIES, glbUrl } from "./rig"
import { SCALE_MAX, SCALE_MIN } from "./resolution"
import { LEVELS, LEVEL_IDS, MAX_FPS, isDedicatedGpu, isLevelId, isSoftwareRenderer, movingIntervalMs, probeGpu, resolveLevel } from "./quality"

describe("the levels", () => {
  test("three, in order of what they ask of the machine, and each has its assets", () => {
    expect(LEVEL_IDS).toEqual(["bassa", "media", "alta"])
    for (const id of LEVEL_IDS) {
      expect(LEVELS[id].id).toBe(id)
      // Bassa and Media ship; Alta's 2K set is a download of its own, and the world falls back to Media without it.
      if (id !== "alta")
        for (const file of [...BODIES.map((body) => `character_${body}.glb`), "city.glb"]) expect(existsSync(join(LEVELS_DIR, id, file))).toBe(true)
      // The address the world asks for is the folder the assets were put in.
      expect(glbUrl("./assets/", id, "user")).toBe(`./assets/levels/${id}/character_user.glb`)
    }
    expect(existsSync(join(LEVELS_DIR, "rig_animations.glb"))).toBe(true)
  })

  test("Bassa is the classic renderer, Media and Alta are WebGPU, and what they ask for only grows", () => {
    expect(LEVELS.bassa.renderer).toBe("classic")
    expect(LEVELS.media.renderer).toBe("webgpu")
    expect(LEVELS.alta.renderer).toBe("webgpu")
    expect(LEVELS.bassa.pixelRatio).toBeLessThan(LEVELS.media.pixelRatio)
    expect(LEVELS.media.pixelRatio).toBeLessThan(LEVELS.alta.pixelRatio)
    expect(LEVELS.bassa.fps).toBeLessThan(LEVELS.media.fps)
    // Nothing goes over 60, whatever the display offers: Alta is finer (pixels, effects), not faster.
    for (const level of Object.values(LEVELS)) expect(level.fps).toBeLessThanOrEqual(MAX_FPS)
    expect(MAX_FPS).toBe(60)
    expect(LEVELS.alta.fps).toBe(MAX_FPS)
  })

  test("Media's resolution scale stops at 0.9 (MSAA 4x stays); the levels that do not move it draw at 1", () => {
    expect(LEVELS.media.maxScale).toBe(0.9)
    expect(LEVELS.media.maxScale).toBeGreaterThanOrEqual(SCALE_MIN)
    expect(LEVELS.bassa.maxScale).toBe(1)
    expect(LEVELS.alta.maxScale).toBe(1)
    for (const level of Object.values(LEVELS)) expect(level.maxScale).toBeLessThanOrEqual(SCALE_MAX)
  })

  test("no level turns on what the budget forbids: it is a fact of the type, so a level with a shadow or a bloom would not compile", () => {
    for (const level of Object.values(LEVELS)) expect(Object.keys(level).sort()).toEqual(["dynamicResolution", "fps", "id", "label", "maxScale", "pixelRatio", "renderer"])
  })

  test("the moving mode's interval is the level's frame rate", () => {
    expect(movingIntervalMs(LEVELS.bassa)).toBeCloseTo(33.33, 1)
    expect(movingIntervalMs(LEVELS.media)).toBeCloseTo(16.67, 1)
    expect(movingIntervalMs(LEVELS.alta)).toBeCloseTo(16.67, 1)
  })

  test("a level id is one of the three and nothing else", () => {
    expect(["bassa", "media", "alta"].every(isLevelId)).toBe(true)
    for (const not of ["auto", "", "Alta", "ultra", undefined, null, 1]) expect(isLevelId(not)).toBe(false)
  })
})

describe("the level the world picks", () => {
  const strong = { webgpu: true, dedicated: true }
  const web = { webgpu: true, dedicated: false }
  const none = { webgpu: false, dedicated: false }

  test("Auto is Media with WebGPU, Alta only with a dedicated GPU, and Bassa without WebGPU", () => {
    expect(resolveLevel(undefined, web).level.id).toBe("media")
    expect(resolveLevel("auto", web).level.id).toBe("media")
    expect(resolveLevel("auto", strong).level.id).toBe("alta")
    expect(resolveLevel(undefined, none).level.id).toBe("bassa")
    // A dedicated GPU without WebGPU is not something that exists, but it must not raise the level.
    expect(resolveLevel(undefined, { webgpu: false, dedicated: true }).level.id).toBe("bassa")
  })

  test("what is asked for is given when the machine can run it", () => {
    expect(resolveLevel("bassa", strong).level.id).toBe("bassa")
    expect(resolveLevel("media", strong).level.id).toBe("media")
    expect(resolveLevel("alta", strong).level.id).toBe("alta")
    expect(resolveLevel("media", web).level.id).toBe("media")
    expect(resolveLevel("bassa", none).level.id).toBe("bassa")
  })

  test("what the machine cannot run is lowered, and the reason says why", () => {
    const alta = resolveLevel("alta", web)
    expect([alta.level.id, alta.why]).toEqual(["media", "richiesto Alta, ma senza GPU dedicata: Media"])
    const noWebgpu = resolveLevel("alta", none)
    expect([noWebgpu.level.id, noWebgpu.why]).toEqual(["bassa", "richiesto Alta, ma senza WebGPU: Bassa"])
    expect(resolveLevel("media", none).level.id).toBe("bassa")
  })

  test("a request that is not a level is Auto", () => {
    expect(resolveLevel("ultra", strong).level.id).toBe("alta")
    expect(resolveLevel("", web).level.id).toBe("media")
  })
})

describe("a dedicated GPU", () => {
  test("NVIDIA cards are, and Tegra is not", () => {
    expect(isDedicatedGpu({ vendor: "nvidia", architecture: "ada", description: "NVIDIA GeForce RTX 4070" })).toBe(true)
    expect(isDedicatedGpu({ vendor: "NVIDIA", architecture: "", device: "" })).toBe(true)
    expect(isDedicatedGpu({ vendor: "nvidia", architecture: "", description: "NVIDIA Tegra X1" })).toBe(false)
  })

  test("AMD's Radeon RX and Pro are, the Radeon Graphics of an APU is not", () => {
    expect(isDedicatedGpu({ vendor: "amd", architecture: "rdna-3", description: "AMD Radeon RX 7800 XT" })).toBe(true)
    expect(isDedicatedGpu({ vendor: "amd", architecture: "", description: "AMD Radeon Pro W7800" })).toBe(true)
    expect(isDedicatedGpu({ vendor: "amd", architecture: "rdna-2", description: "AMD Radeon(TM) Graphics" })).toBe(false)
    expect(isDedicatedGpu({ vendor: "amd", architecture: "rdna-3" })).toBe(false)
  })

  test("Intel's Arc is, its integrated graphics are not", () => {
    expect(isDedicatedGpu({ vendor: "intel", architecture: "xe-hpg", description: "Intel(R) Arc(TM) A770 Graphics" })).toBe(true)
    expect(isDedicatedGpu({ vendor: "intel", architecture: "gen-12lp", description: "Intel(R) Iris(R) Xe Graphics" })).toBe(false)
    expect(isDedicatedGpu({ vendor: "intel", architecture: "gen-11", description: "Intel(R) UHD Graphics 630" })).toBe(false)
  })

  test("software, fallback and unknown adapters are not, and neither is no answer at all", () => {
    expect(isDedicatedGpu(undefined)).toBe(false)
    expect(isDedicatedGpu({})).toBe(false)
    expect(isDedicatedGpu({ vendor: "nvidia", isFallbackAdapter: true })).toBe(false)
    expect(isDedicatedGpu({ vendor: "google", architecture: "swiftshader", description: "SwiftShader" })).toBe(false)
    expect(isDedicatedGpu({ vendor: "microsoft", description: "Microsoft Basic Render Driver" })).toBe(false)
    expect(isDedicatedGpu({ vendor: "apple", architecture: "metal-3", description: "Apple M2" })).toBe(false)
    expect(isDedicatedGpu({ vendor: "qualcomm", description: "Adreno" })).toBe(false)
  })
})

describe("asking the browser what GPU there is", () => {
  test("no WebGPU in the frame, no adapter, and an adapter that throws: none can be used, and each says so", async () => {
    expect(await probeGpu(undefined)).toEqual({ webgpu: false, dedicated: false, why: "WebGPU non disponibile nel frame" })
    expect(await probeGpu({ requestAdapter: async () => null })).toMatchObject({ webgpu: false, why: "nessun adattatore WebGPU" })
    const thrown = await probeGpu({
      requestAdapter: async () => {
        throw new Error("blocked")
      },
    })
    expect(thrown.webgpu).toBe(false)
    expect(thrown.why).toContain("blocked")
  })

  test("it asks for the strong adapter and reads what it says about itself", async () => {
    let asked: unknown
    const probe = await probeGpu({
      requestAdapter: async (options) => {
        asked = options
        return { info: { vendor: "nvidia", architecture: "ada", description: "NVIDIA GeForce RTX 4070" } }
      },
    })
    expect(asked).toEqual({ powerPreference: "high-performance" })
    expect([probe.webgpu, probe.dedicated]).toEqual([true, true])
    const soft = await probeGpu({ requestAdapter: async () => ({ info: { vendor: "nvidia" }, isFallbackAdapter: true }) })
    // A software adapter is no GPU (old PCs, point 1): the level is Bassa, as without WebGPU.
    expect([soft.webgpu, soft.dedicated]).toEqual([false, false])
  })
})

describe("a slow machine picks Bassa by itself", () => {
  const webgpu = { webgpu: true, dedicated: false }
  const strong = { webgpu: true, dedicated: true }

  test("four processors or fewer: Bassa, and the reason says why", () => {
    for (const cores of [1, 2, 4]) {
      const resolved = resolveLevel(undefined, strong, cores)
      expect(resolved.level.id).toBe("bassa")
      expect(resolved.why).toBe(`automatico: Bassa (${cores} processori)`)
    }
    expect(resolveLevel("auto", webgpu, 4).level.id).toBe("bassa")
  })

  test("more processors, or a number the browser does not give, change nothing", () => {
    expect(resolveLevel(undefined, webgpu, 8).level.id).toBe("media")
    expect(resolveLevel(undefined, strong, 6).level.id).toBe("alta")
    expect(resolveLevel(undefined, webgpu, undefined).level.id).toBe("media")
    expect(resolveLevel(undefined, webgpu, 0).level.id).toBe("media")
  })

  test("a level asked for by name is not second-guessed by the processor count", () => {
    expect(resolveLevel("media", webgpu, 2).level.id).toBe("media")
  })
})

describe("a renderer drawn in software", () => {
  test("SwiftShader, llvmpipe, WARP and the like are software; a real GPU, or nothing known, is not", () => {
    expect(isSoftwareRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)")).toBe(true)
    expect(isSoftwareRenderer("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true)
    expect(isSoftwareRenderer("ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)")).toBe(true)
    expect(isSoftwareRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(false)
    expect(isSoftwareRenderer("WebKit WebGL")).toBe(false)
    expect(isSoftwareRenderer(undefined)).toBe(false)
  })
})

describe("a WebGPU adapter that is software", () => {
  test("is no GPU: the automatic level is Bassa, and the probe says why", async () => {
    const fallback = { requestAdapter: async () => ({ info: { vendor: "google", description: "SwiftShader" }, isFallbackAdapter: true }) }
    const probe = await probeGpu(fallback)
    expect([probe.webgpu, probe.dedicated, probe.why]).toEqual([false, false, "adattatore WebGPU software"])
    expect(resolveLevel(undefined, probe, 16).level.id).toBe("bassa")
  })
})
