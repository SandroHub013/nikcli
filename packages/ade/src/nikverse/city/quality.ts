/**
 * The three quality levels, and how the world picks one by itself.
 *
 * Bassa draws with the classic WebGL renderer, no effects, the 512 px assets, 30 frames a second when
 * moving. Media is WebGPU with the 1024 px assets at up to 60. Alta is WebGPU too, with the 2048 px assets
 * at the display's own rate, and only where the GPU is a dedicated one. What a level is *for* is the
 * budget's: the CPU is the limit, so no level turns on dynamic shadows or bloom; they differ in the
 * renderer, the size of the textures, the pixel ratio and the frame rate of the moving mode.
 *
 * Without WebGPU the world is Bassa whatever was asked for: the classic renderer is not Media, and it is
 * never `WebGPURenderer` on its WebGL backend.
 */

export type LevelId = "bassa" | "media" | "alta"

export const LEVEL_IDS: readonly LevelId[] = ["bassa", "media", "alta"]

export interface Level {
  id: LevelId
  label: string
  renderer: "classic" | "webgpu"
  /** The most the pixel ratio may be, whatever the display's. */
  pixelRatio: number
  /** Frames a second while something moves; 0 is the display's own rate. */
  fps: number
}

export const LEVELS: Readonly<Record<LevelId, Level>> = {
  bassa: { id: "bassa", label: "Bassa", renderer: "classic", pixelRatio: 1, fps: 30 },
  media: { id: "media", label: "Media", renderer: "webgpu", pixelRatio: 1.5, fps: 60 },
  alta: { id: "alta", label: "Alta", renderer: "webgpu", pixelRatio: 2, fps: 0 },
}

export const isLevelId = (value: unknown): value is LevelId => LEVEL_IDS.includes(value as LevelId)

/** What the adapter says about itself (`GPUAdapter.info`), all of it optional: browsers give what they give. */
export interface AdapterInfo {
  vendor?: string
  architecture?: string
  device?: string
  description?: string
  isFallbackAdapter?: boolean
}

/**
 * Whether an adapter is a dedicated GPU. Only what says so plainly counts: an unknown adapter is not
 * dedicated, because a wrong yes costs a slow city and a wrong no costs a softer one.
 */
export function isDedicatedGpu(info: AdapterInfo | undefined): boolean {
  if (!info || info.isFallbackAdapter) return false
  const vendor = (info.vendor ?? "").toLowerCase()
  const text = `${info.architecture ?? ""} ${info.device ?? ""} ${info.description ?? ""}`.toLowerCase()
  if (/swiftshader|llvmpipe|software|basic render|warp|microsoft/.test(`${vendor} ${text}`)) return false
  if (vendor.includes("nvidia")) return !/tegra|jetson/.test(text)
  if (vendor.includes("amd") || vendor.includes("ati")) return /radeon[^,]*\b(rx|pro|r9|r7|vii)\b|instinct/.test(text)
  if (vendor.includes("intel")) return /\barc\b|alchemist|battlemage|xe-hpg|xe2-hpg|\bb5\d0\b|\ba[3-7]\d0\b/.test(text)
  return false
}

export interface GpuProbe {
  /** An adapter was given: WebGPU can be used. */
  webgpu: boolean
  dedicated: boolean
  info?: AdapterInfo
  why?: string
}

/** Asks the browser for an adapter, preferring the strong one, and reads what it says about itself. */
export async function probeGpu(gpu: { requestAdapter(options?: { powerPreference?: string }): Promise<unknown> } | undefined): Promise<GpuProbe> {
  if (!gpu) return { webgpu: false, dedicated: false, why: "WebGPU non disponibile nel frame" }
  try {
    const adapter = (await gpu.requestAdapter({ powerPreference: "high-performance" })) as { info?: AdapterInfo; isFallbackAdapter?: boolean } | null
    if (!adapter) return { webgpu: false, dedicated: false, why: "nessun adattatore WebGPU" }
    const info: AdapterInfo = { ...adapter.info, isFallbackAdapter: adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter }
    return { webgpu: true, dedicated: isDedicatedGpu(info), info }
  } catch (error) {
    return { webgpu: false, dedicated: false, why: `requestAdapter ha fallito: ${String((error as Error)?.message ?? error).slice(0, 120)}` }
  }
}

export interface Resolved {
  level: Level
  /** Why it is not what was asked for, or how Auto chose. */
  why: string
}

/**
 * The level to run at. `request` is what was asked for (`auto`, or nothing, or a level's id); a level the
 * machine cannot run is lowered to the best one it can: Alta needs WebGPU and a dedicated GPU, Media needs WebGPU.
 */
export function resolveLevel(request: string | undefined, gpu: Pick<GpuProbe, "webgpu" | "dedicated">): Resolved {
  const best: LevelId = gpu.webgpu ? (gpu.dedicated ? "alta" : "media") : "bassa"
  if (!isLevelId(request)) return { level: LEVELS[best], why: `automatico: ${LEVELS[best].label}${gpu.webgpu ? (gpu.dedicated ? " (WebGPU, GPU dedicata)" : " (WebGPU)") : " (senza WebGPU)"}` }
  const rank = (id: LevelId) => LEVEL_IDS.indexOf(id)
  if (rank(request) <= rank(best)) return { level: LEVELS[request], why: `richiesto: ${LEVELS[request].label}` }
  const reason = request === "alta" && gpu.webgpu ? "senza GPU dedicata" : "senza WebGPU"
  return { level: LEVELS[best], why: `richiesto ${LEVELS[request].label}, ma ${reason}: ${LEVELS[best].label}` }
}

/** The frame interval of the moving mode at a level, in milliseconds; 0 means every frame the display offers. */
export const movingIntervalMs = (level: Level): number => (level.fps > 0 ? 1000 / level.fps : 0)
