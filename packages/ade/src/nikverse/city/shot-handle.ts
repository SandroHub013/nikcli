/**
 * `?shot=N`: the bench's page. It skips ADE's picture and draws the fixed scene (`shots.ts`) from shot N's camera at
 * 1600×900 with a pixel ratio of 1, once, and keeps the picture and its numbers for the script that drives it:
 * `window.__nikverseShot` holds the PNG (a data address) and the stats; `data-shot` says `ready` or `failed`.
 * The picture is read from the canvas in the very task that draws it, which is the only time a WebGPU canvas has it.
 */

import { RenderTarget, type PerspectiveCamera } from "three/webgpu"
import { spawnPlayer } from "./controller"
import { benchScaled } from "./gpu-idle"
import { disposeTree, releaseRenderer } from "./release"
import type { Backend, DrawingSurface } from "./renderers"
import type { LevelId } from "./quality"
import { analyze, problemsOf, type ShotStats } from "./shot-stats"
import { SHOT_CLOCK, SHOT_HEIGHT, SHOT_SHOPS, SHOT_WIDTH, shotOf, shotPicture } from "./shots"
import { RISE_SECONDS, type Town } from "./town"
import type { CityView } from "./view"

export interface ShotResult {
  n: number
  name: string
  backend: string
  level: LevelId
  width: number
  height: number
  stats: ShotStats
  problems: string[]
  /** `data:image/png;base64,…`: the picture as it is. */
  png: string
  /** The same picture as a JPEG (quality 0.9), small enough to put many in a page. */
  jpg: string
}

export interface ShotParts {
  win: Window & typeof globalThis
  shot: number
  renderer: DrawingSurface
  canvas: HTMLCanvasElement
  backend: string
  level: LevelId
  view: CityView
  town: Town
  camera: PerspectiveCamera
  /** Whether the level moves its resolution with the GPU time: the bench then settles where the governor would. */
  dynamic: boolean
  /** Whether N3's people and shops loaded, for `info()`. */
  cast: boolean
  kit: boolean
}

/** The town at the moment of the shot: every shop up and every person seated, a rising shop half way. */
export function stageShot(town: Town, n: number): void {
  const shot = shotOf(n)
  if (!shot) throw new Error(`nessuna inquadratura ${n}`)
  town.sync(shotPicture(shot.rising ? SHOT_SHOPS - 1 : SHOT_SHOPS))
  for (let i = 0; i < 240; i++) town.tick(0.05)
  if (shot.rising) {
    town.sync(shotPicture())
    town.tick(RISE_SECONDS / 2)
  }
}

const frames = (win: Window, times: number) =>
  new Promise<void>((resolve) => {
    let left = times
    const step = () => (--left <= 0 ? resolve() : win.requestAnimationFrame(step))
    win.requestAnimationFrame(step)
    // A page that is hidden gets no animation frames: do not wait for them.
    win.setTimeout(resolve, 400)
  })

async function toDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${blob.type};base64,${btoa(binary)}`
}

/** Draws the shot and reads it. Exposed for the tests of the pieces around it; the page uses `startShot`. */
export async function takeShot(parts: ShotParts): Promise<ShotResult> {
  const { win, renderer, canvas, view, town, camera } = parts
  const shot = shotOf(parts.shot)
  if (!shot) throw new Error(`nessuna inquadratura ${parts.shot}`)
  renderer.setPixelRatio(1)
  renderer.setSize(SHOT_WIDTH, SHOT_HEIGHT, false)
  canvas.style.width = `${SHOT_WIDTH}px`
  canvas.style.height = `${SHOT_HEIGHT}px`
  stageShot(town, parts.shot)
  view.user.group.visible = false
  camera.fov = shot.fov
  camera.aspect = SHOT_WIDTH / SHOT_HEIGHT
  camera.updateProjectionMatrix()
  camera.position.set(...shot.eye)
  camera.lookAt(...shot.look)
  view.update(town, spawnPlayer(), SHOT_CLOCK, camera)

  const compile = (renderer as unknown as { compileAsync?(scene: unknown, camera: unknown): Promise<void> })
    .compileAsync
  if (compile) await compile.call(renderer, view.scene, camera)
  // Warm-up: the first frames of a WebGPU renderer can leave out what is still being compiled.
  for (let i = 0; i < 3; i++) {
    renderer.render(view.scene, camera)
    await frames(win, 2)
  }

  const copy = new OffscreenCanvas(SHOT_WIDTH, SHOT_HEIGHT)
  const g = copy.getContext("2d", { willReadFrequently: true })
  if (!g) throw new Error("nessun contesto 2D per leggere il quadro")
  // The same task as the render: the canvas still holds the frame.
  renderer.render(view.scene, camera)
  g.drawImage(canvas, 0, 0)
  const hex = (view.scene.background as { getHex(): number } | null)?.getHex() ?? 0
  const sky = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255] as const
  const stats = analyze(g.getImageData(0, 0, SHOT_WIDTH, SHOT_HEIGHT).data, SHOT_WIDTH, SHOT_HEIGHT, sky)
  const png = await toDataUrl(await copy.convertToBlob({ type: "image/png" }))
  const jpg = await toDataUrl(await copy.convertToBlob({ type: "image/jpeg", quality: 0.9 }))
  return {
    n: shot.n,
    name: shot.name,
    backend: parts.backend,
    level: parts.level,
    width: SHOT_WIDTH,
    height: SHOT_HEIGHT,
    stats,
    problems: problemsOf(stats, shot.luminance),
    png,
    jpg,
  }
}

/** The handle the page gets: the picture is taken once, at start, and nothing else moves. */
export async function startShot(parts: ShotParts) {
  const data = parts.win.document.documentElement.dataset
  try {
    const result = await takeShot(parts)
    ;(parts.win as unknown as { __nikverseShot?: ShotResult }).__nikverseShot = result
    data.shot = "ready"
    data.shotProblems = result.problems.join(" | ").slice(0, 400)
    data.ready = "1"
  } catch (error) {
    data.shot = "failed"
    data.shotError = String((error as Error)?.message ?? error).slice(0, 300)
    throw error
  }
  return {
    sync() {},
    pause() {},
    resume() {},
    restore() {},
    info: () => ({
      backend: parts.backend as Backend,
      mode: "city" as const,
      level: parts.level,
      cast: parts.cast,
      kit: parts.kit,
    }),
    /** The GPU time of this shot's view, drawn back to back: what the bench reports beside the picture. */
    bench: async (frames = 240) => {
      // Where the level moves its resolution, at the scale the governor would settle at (`resolution.ts`).
      return benchScaled({
        renderer: parts.renderer,
        backend: parts.backend as Backend,
        scene: parts.view.scene,
        camera: parts.camera,
        makeTarget: (width, height) => new RenderTarget(width, height, { samples: 4 }),
        width: parts.canvas.width,
        height: parts.canvas.height,
        dynamic: parts.dynamic,
        frames,
      })
    },
    dispose() {
      parts.view.dispose()
      disposeTree(parts.view.scene)
      releaseRenderer(parts.renderer)
      parts.canvas.remove()
    },
  }
}
