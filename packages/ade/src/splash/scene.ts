/**
 * Scene renderer for the ADE pixel-art splash screen.
 *
 * Renders the cooking scene at 160x90 logical resolution (16:9):
 * - Developer at left (human-scale, ~2x pot height) stirring, tasting, and thumbs-up;
 * - Iconic Ragu pot at center boiling, steaming, and bobbing at 8fps;
 * - Fresh counter tomato and basil sprig;
 * - Open laptop running colorful ADE code at right;
 * - Large 100px "Ragù Code" wordmark centered below (~60% width);
 * - Crisp integer pixelated scaling on <canvas> across 800px to 4K.
 */

import {
  BASIL_SPRITE,
  DEVELOPER_POSES,
  DEVELOPER_SPRITE_SIZE,
  LAPTOP_SPRITE,
  POT_FRAMES,
  POT_SPRITE_SIZE,
  SPLASH_PALETTE,
  TOMATO_SPRITE,
  WORDMARK_GRID,
  WORDMARK_HEIGHT,
  WORDMARK_NATIVE_HEIGHT,
  WORDMARK_NATIVE_WIDTH,
  WORDMARK_SCALE,
  WORDMARK_WIDTH,
} from "./sprites"

/** Logical resolution of the scene in pixels (exact 16:9 aspect ratio). */
export const SCENE_WIDTH = 160
export const SCENE_HEIGHT = 90

/** Background color (brand ink ground). */
export const INK_BACKGROUND = SPLASH_PALETTE.a! // #120d0b

/** Kitchen counter / desk line color. */
export const COUNTER_COLOR = SPLASH_PALETTE.l! // #241e1b

/** Layout coordinates within the 160x90 logical canvas. */
export const SCENE_LAYOUT = {
  developer: { x: 30, y: 15 },
  tomato: { x: 62, y: 44 },
  basil: { x: 68, y: 45 },
  pot: { x: 64, y: 17 },
  laptop: { x: 96, y: 35 },
  counter: { y: 49 },
  wordmark: { x: (SCENE_WIDTH - WORDMARK_WIDTH) / 2, y: 62 },
} as const

/** Cadence timings in milliseconds. */
export const POT_FRAME_INTERVAL_MS = 125 // ~8 frames per second
export const DEV_POSE_INTERVAL_MS = 1000 // 1 second per developer pose

/**
 * Calculates the integer scale factor so the logical 160x90 canvas fills as much
 * of the viewport as possible without clipping, staying pixel-perfect.
 */
export function calculateIntegerScale(viewportWidth: number, viewportHeight: number): number {
  if (viewportWidth <= 0 || viewportHeight <= 0) return 1
  const scaleX = Math.floor(viewportWidth / SCENE_WIDTH)
  const scaleY = Math.floor(viewportHeight / SCENE_HEIGHT)
  return Math.max(1, Math.min(scaleX, scaleY))
}

/**
 * Computes which pot frame and developer pose should be active at a given elapsed time.
 */
export function getActiveFrames(elapsedMs: number): {
  potFrameIndex: number
  devPoseIndex: number
} {
  const potFrameIndex = Math.floor(Math.max(0, elapsedMs) / POT_FRAME_INTERVAL_MS) % POT_FRAMES.length
  const devPoseIndex = Math.floor(Math.max(0, elapsedMs) / DEV_POSE_INTERVAL_MS) % DEVELOPER_POSES.length
  return { potFrameIndex, devPoseIndex }
}

/**
 * Draws a 2D sprite character grid onto a 2D canvas rendering context at (offsetX, offsetY).
 * Skips transparent pixels ('.').
 */
export function drawSpriteGrid(
  ctx: CanvasRenderingContext2D,
  grid: readonly string[],
  offsetX: number,
  offsetY: number,
): void {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!
    const y = offsetY + r
    for (let c = 0; c < row.length; c++) {
      const char = row[c]!
      if (char === ".") continue
      const color = SPLASH_PALETTE[char]
      if (color && color !== "transparent") {
        ctx.fillStyle = color
        ctx.fillRect(offsetX + c, y, 1, 1)
      }
    }
  }
}

/**
 * Draws the CLI-derived wordmark at 2x scale (80x20 pixels).
 * Uses half-block decoded colors directly with zero dark outline.
 */
export function drawWordmark(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
): void {
  for (let r = 0; r < WORDMARK_NATIVE_HEIGHT; r++) {
    const row = WORDMARK_GRID[r]!
    const y = offsetY + r * WORDMARK_SCALE
    for (let c = 0; c < WORDMARK_NATIVE_WIDTH; c++) {
      const color = row[c]!
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(offsetX + c * WORDMARK_SCALE, y, WORDMARK_SCALE, WORDMARK_SCALE)
    }
  }
}

/**
 * Renders the entire splash cooking scene for a given developer pose and pot frame.
 */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  devPoseIndex: number,
  potFrameIndex: number,
): void {
  // 1. Fill ink background
  ctx.fillStyle = INK_BACKGROUND
  ctx.fillRect(0, 0, SCENE_WIDTH, SCENE_HEIGHT)

  // 2. Kitchen counter / desk line
  ctx.fillStyle = COUNTER_COLOR
  ctx.fillRect(16, SCENE_LAYOUT.counter.y, SCENE_WIDTH - 32, 2)

  // 3. Counter fresh ingredients: tomato & basil sprig
  drawSpriteGrid(ctx, TOMATO_SPRITE, SCENE_LAYOUT.tomato.x, SCENE_LAYOUT.tomato.y)
  drawSpriteGrid(ctx, BASIL_SPRITE, SCENE_LAYOUT.basil.x, SCENE_LAYOUT.basil.y)

  // 4. Laptop on desk running ADE code
  drawSpriteGrid(ctx, LAPTOP_SPRITE, SCENE_LAYOUT.laptop.x, SCENE_LAYOUT.laptop.y)

  // 5. Canonical Ragu cooking pot (center)
  const potFrame = POT_FRAMES[potFrameIndex] ?? POT_FRAMES[0]!
  drawSpriteGrid(ctx, potFrame, SCENE_LAYOUT.pot.x, SCENE_LAYOUT.pot.y)

  // 6. Developer (left, stirring into pot / tasting)
  const devPose = DEVELOPER_POSES[devPoseIndex] ?? DEVELOPER_POSES[0]!
  drawSpriteGrid(ctx, devPose, SCENE_LAYOUT.developer.x, SCENE_LAYOUT.developer.y)

  // 7. Wordmark "Ragù Code" (centered bottom, 50% width / 80px, CLI half-block)
  drawWordmark(ctx, SCENE_LAYOUT.wordmark.x, SCENE_LAYOUT.wordmark.y)
}

export interface SceneController {
  /** Resizes canvas style dimensions to integer scale matching viewport. */
  resize: (viewportWidth: number, viewportHeight: number) => number
  /** Stops the animation loop and frees listeners. */
  stop: () => void
}

/**
 * Mounts and starts the pixel-art splash scene on a canvas element.
 * Respects prefers-reduced-motion by rendering a single static frame without running a loop.
 */
export function startPixelScene(
  canvas: HTMLCanvasElement,
  options?: {
    prefersReducedMotion?: boolean
    onFirstFrameRendered?: () => void
  },
): SceneController {
  canvas.width = SCENE_WIDTH
  canvas.height = SCENE_HEIGHT

  const ctx = canvas.getContext("2d", { alpha: false })
  if (!ctx) {
    return {
      resize: () => 1,
      stop: () => {},
    }
  }

  // Disable browser image smoothing so pixels remain hard and crisp
  ctx.imageSmoothingEnabled = false

  const reducedMotion = options?.prefersReducedMotion ?? false
  let animId: ReturnType<typeof requestAnimationFrame> | number | null = null
  let stopped = false
  const startTime = performance.now()

  const resize = (viewportWidth: number, viewportHeight: number): number => {
    const scale = calculateIntegerScale(viewportWidth, viewportHeight)
    canvas.style.width = `${SCENE_WIDTH * scale}px`
    canvas.style.height = `${SCENE_HEIGHT * scale}px`
    return scale
  }

  if (reducedMotion) {
    // Static pose: thumbs up (pose 6) and simmering pot (frame 0)
    renderScene(ctx, 6, 0)
    options?.onFirstFrameRendered?.()
    return {
      resize,
      stop: () => {
        stopped = true
      },
    }
  }

  let firstFrameReported = false

  const tick = (now: number) => {
    animId = null
    if (stopped) return

    const elapsed = now - startTime
    const { potFrameIndex, devPoseIndex } = getActiveFrames(elapsed)
    renderScene(ctx, devPoseIndex, potFrameIndex)

    if (!firstFrameReported) {
      firstFrameReported = true
      options?.onFirstFrameRendered?.()
    }

    if (!stopped && !document.hidden) {
      animId = requestAnimationFrame(tick)
    }
  }

  // Handle visibility changes to conserve GPU/CPU when hidden
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
