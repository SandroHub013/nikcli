/**
 * Scene renderer and stage layout for the ADE splash screen.
 *
 * Displays the full reference artwork ("scena-sinistra.png") at 1672x941 aspect ratio
 * with an overlay canvas animating:
 * - Rising & swaying steam puffs from the ragù pot (#efe2c8)
 * - Simmering bubbles growing and popping into droplets with gravity
 * - Glistening sparkles (+ arm shape) above the cooking area (#f6ead2)
 * - Developer eye blink (skin tone #fb9b60 + dark lid #1a0d08)
 * - Green terminal blinking cursor on laptop code (#5fa83a)
 *
 * Responsive layout scales cleanly from 800px viewports up to 4K displays
 * across DPR 1.0, 1.25, and 1.5, keeping the stage and status message comfortably
 * within the screen bounds.
 *
 * Honors prefers-reduced-motion: canvas remains completely clear (static reference image only).
 */

import { createFxState, drawFx, spawnFx } from "./scene-fx"

/** Full reference scene native dimensions (1672x941). */
export const REF_WIDTH = 1672
export const REF_HEIGHT = 941
export const REF_ASPECT_RATIO = 1672 / 941 // ~1.7768

/** Background color matching the reference image border and splash root. */
export const SPLASH_BACKGROUND = "#211410"

export interface StageDimensions {
  width: number
  height: number
  scale: number
  left: number
  top: number
}

/**
 * Computes responsive stage dimensions for the reference scene (1672x941)
 * within the given viewport, ensuring the entire stage and the status message below it
 * fit comfortably inside the window across all viewports from 800px to 4K.
 */
export function computeStageDimensions(
  viewportWidth: number,
  viewportHeight: number,
  _dpr: number = 1,
): StageDimensions {
  const statusSpace = 48
  const maxW = Math.max(1, viewportWidth * 0.94)
  const maxH = Math.max(1, viewportHeight - statusSpace)

  let width = maxW
  let height = (width * REF_HEIGHT) / REF_WIDTH
  if (height > maxH) {
    height = maxH
    width = (height * REF_WIDTH) / REF_HEIGHT
  }

  width = Math.round(width)
  height = Math.round(height)
  const left = Math.round((viewportWidth - width) / 2)
  const top = Math.round((viewportHeight - (height + 26)) / 2)

  return {
    width,
    height,
    scale: width / REF_WIDTH,
    left: Math.max(0, left),
    top: Math.max(0, top),
  }
}

/**
 * Sizes the stage and container within the viewport and initializes canvas buffer.
 * Callable immediately on mount so the status text is positioned correctly before the scene starts.
 */
export function layoutSceneContainer(
  canvas: HTMLCanvasElement,
  viewportWidth: number,
  viewportHeight: number,
  dpr: number = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
): number {
  const dims = computeStageDimensions(viewportWidth, viewportHeight, dpr)

  if (canvas.width !== REF_WIDTH) canvas.width = REF_WIDTH
  if (canvas.height !== REF_HEIGHT) canvas.height = REF_HEIGHT

  const stage = (canvas.closest?.('[data-slot="splash-stage"]') ?? (canvas.parentElement?.getAttribute("data-slot") === "splash-stage" ? canvas.parentElement : null)) as HTMLElement | null
  const container = (canvas.closest?.('[data-slot="splash-scene-container"]') ?? canvas.parentElement) as HTMLElement | null

  if (stage) {
    stage.style.width = `${dims.width}px`
    stage.style.height = `${dims.height}px`
  }

  if (container && container.getAttribute("data-slot") === "splash-scene-container") {
    container.style.width = `${dims.width}px`
    container.style.maxWidth = `${dims.width}px`
  }

  return dims.scale
}

export interface SceneController {
  /** Resizes stage and container matching viewport. */
  resize: (viewportWidth: number, viewportHeight: number, dpr?: number) => number
  /** Stops the animation loop and frees listeners. */
  stop: () => void
}

export interface StartPixelSceneOptions {
  prefersReducedMotion?: boolean
  onFirstFrameRendered?: () => void
}

/**
 * Mounts and starts the overlay FX animation loop on a canvas element.
 * Respects prefers-reduced-motion by clearing the overlay and running no animation loop.
 */
export function startPixelScene(
  canvas: HTMLCanvasElement,
  options?: StartPixelSceneOptions,
): SceneController {
  if (canvas.width !== REF_WIDTH) canvas.width = REF_WIDTH
  if (canvas.height !== REF_HEIGHT) canvas.height = REF_HEIGHT

  const ctx = canvas.getContext("2d")
  if (!ctx) {
    return {
      resize: () => 1,
      stop: () => {},
    }
  }

  ctx.imageSmoothingEnabled = false
  const reducedMotion = options?.prefersReducedMotion ?? false
  let animId: ReturnType<typeof requestAnimationFrame> | number | null = null
  let stopped = false

  const resize = (
    viewportWidth: number,
    viewportHeight: number,
    dpr: number = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
  ): number => layoutSceneContainer(canvas, viewportWidth, viewportHeight, dpr)

  if (reducedMotion) {
    ctx.clearRect(0, 0, REF_WIDTH, REF_HEIGHT)
    options?.onFirstFrameRendered?.()
    return {
      resize,
      stop: () => {
        stopped = true
      },
    }
  }

  const state = createFxState()
  let firstFrameReported = false
  let lastTick = 0
  const FPS_MS = 33 // ~30 FPS

  const tick = (now: number) => {
    animId = null
    if (stopped) return

    if (now - lastTick >= FPS_MS - 2) {
      lastTick = now
      spawnFx(state, now)
      drawFx(ctx, state, now, REF_WIDTH, REF_HEIGHT)
    }

    if (!firstFrameReported) {
      firstFrameReported = true
      options?.onFirstFrameRendered?.()
    }

    if (!stopped && !document.hidden) {
      animId = requestAnimationFrame(tick)
    }
  }

  const onVisibility = () => {
    if (document.hidden) {
      if (animId !== null) cancelAnimationFrame(animId as number)
      animId = null
    } else if (!stopped && animId === null) {
      animId = requestAnimationFrame(tick)
    }
  }

  document.addEventListener("visibilitychange", onVisibility)
  animId = requestAnimationFrame(tick)

  return {
    resize,
    stop: () => {
      if (stopped) return
      stopped = true
      if (animId !== null) {
        cancelAnimationFrame(animId as number)
        animId = null
      }
      document.removeEventListener("visibilitychange", onVisibility)
    },
  }
}
