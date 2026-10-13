/**
 * Which renderer draws the city.
 *
 * With WebGPU in the frame, `WebGPURenderer`. Without it, the classic
 * `WebGLRenderer`, and never `WebGPURenderer` on its WebGL backend: that one
 * compiles the node materials slowly (several seconds) and buys nothing over the
 * classic renderer. A canvas that has been given a `webgpu` context cannot be
 * given a `webgl2` one, so a failed WebGPU start is retried on a fresh canvas.
 *
 * The parts that touch the browser are passed in, so the choice is a plain
 * function a test can drive with fakes.
 */

export type Backend = "webgpu" | "webgl2"

/** What the loop needs of a renderer: both three.js renderers have it. */
export interface DrawingSurface {
  render(scene: unknown, camera: unknown): void
  setSize(width: number, height: number, updateStyle?: boolean): void
  setPixelRatio(ratio: number): void
  setClearColor(color: number, alpha?: number): void
  dispose(): void
  toneMapping: number
}

export interface RendererOptions {
  antialias: boolean
  alpha: boolean
}

export interface RendererDeps<Canvas> {
  makeCanvas(): Canvas
  /** `navigator.gpu`, when the frame has it. */
  gpu: { requestAdapter(): Promise<unknown> } | undefined
  /** Starts `WebGPURenderer` on a canvas; it must reject if what it got is not WebGPU. */
  createWebGPU(canvas: Canvas, options: RendererOptions): Promise<DrawingSurface>
  createClassic(canvas: Canvas, options: RendererOptions): DrawingSurface
  options: RendererOptions
  /** Use the classic renderer even where WebGPU exists (`?renderer=classic`, for comparing the two). */
  classic?: boolean
}

export interface Chosen<Canvas> {
  renderer: DrawingSurface
  canvas: Canvas
  backend: Backend
  /** Why WebGPU was not used, when it was not: for the page's data attributes. */
  why?: string
}

export async function chooseRenderer<Canvas>(deps: RendererDeps<Canvas>): Promise<Chosen<Canvas>> {
  let why = "WebGPU non disponibile nel frame"
  if (deps.classic) why = "richiesto il renderer classico"
  else if (deps.gpu) {
    try {
      if (await deps.gpu.requestAdapter()) {
        const canvas = deps.makeCanvas()
        try {
          return { renderer: await deps.createWebGPU(canvas, deps.options), canvas, backend: "webgpu" }
        } catch (error) {
          why = `WebGPURenderer non è partito: ${String((error as Error)?.message ?? error).slice(0, 120)}`
        }
      } else why = "nessun adattatore WebGPU"
    } catch (error) {
      why = `requestAdapter ha fallito: ${String((error as Error)?.message ?? error).slice(0, 120)}`
    }
  }
  const canvas = deps.makeCanvas()
  return { renderer: deps.createClassic(canvas, deps.options), canvas, backend: "webgl2", why }
}
