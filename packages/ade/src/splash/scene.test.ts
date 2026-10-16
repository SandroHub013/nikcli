import { describe, expect, mock, test } from "bun:test"
import {
  DEV_POSE_INTERVAL_MS,
  INK_BACKGROUND,
  LAPTOP_SIZE,
  POT_FRAME_INTERVAL_MS,
  SCENE_HEIGHT,
  SCENE_LAYOUT,
  SCENE_WIDTH,
  calculateIntegerScale,
  drawSpriteGrid,
  getActiveFrames,
  renderScene,
  startPixelScene,
} from "./scene"
import {
  DEVELOPER_SPRITE_SIZE,
  POT_SPRITE_SIZE,
  WORDMARK_SIZE,
} from "./sprites"

describe("splash scene renderer (step 2)", () => {
  describe("scene dimensions and layout bounds", () => {
    test("logical dimensions are 96x54 with exact 16:9 aspect ratio", () => {
      expect(SCENE_WIDTH).toBe(96)
      expect(SCENE_HEIGHT).toBe(54)
      expect(SCENE_WIDTH / SCENE_HEIGHT).toBeCloseTo(16 / 9, 5)
    })

    test("all sprites fit within the scene bounds without clipping", () => {
      // Developer
      expect(SCENE_LAYOUT.developer.x).toBeGreaterThanOrEqual(0)
      expect(SCENE_LAYOUT.developer.y).toBeGreaterThanOrEqual(0)
      expect(SCENE_LAYOUT.developer.x + DEVELOPER_SPRITE_SIZE.width).toBeLessThanOrEqual(SCENE_WIDTH)
      expect(SCENE_LAYOUT.developer.y + DEVELOPER_SPRITE_SIZE.height).toBeLessThanOrEqual(SCENE_HEIGHT)

      // Pot
      expect(SCENE_LAYOUT.pot.x).toBeGreaterThanOrEqual(0)
      expect(SCENE_LAYOUT.pot.y).toBeGreaterThanOrEqual(0)
      expect(SCENE_LAYOUT.pot.x + POT_SPRITE_SIZE.width).toBeLessThanOrEqual(SCENE_WIDTH)
      expect(SCENE_LAYOUT.pot.y + POT_SPRITE_SIZE.height).toBeLessThanOrEqual(SCENE_HEIGHT)

      // Laptop
      expect(SCENE_LAYOUT.laptop.x).toBeGreaterThanOrEqual(0)
      expect(SCENE_LAYOUT.laptop.y).toBeGreaterThanOrEqual(0)
      expect(SCENE_LAYOUT.laptop.x + LAPTOP_SIZE.width).toBeLessThanOrEqual(SCENE_WIDTH)
      expect(SCENE_LAYOUT.laptop.y + LAPTOP_SIZE.height).toBeLessThanOrEqual(SCENE_HEIGHT)

      // Wordmark
      expect(SCENE_LAYOUT.wordmark.x).toBeGreaterThanOrEqual(0)
      expect(SCENE_LAYOUT.wordmark.y).toBeGreaterThanOrEqual(0)
      expect(SCENE_LAYOUT.wordmark.x + WORDMARK_SIZE.width).toBeLessThanOrEqual(SCENE_WIDTH)
      expect(SCENE_LAYOUT.wordmark.y + WORDMARK_SIZE.height).toBeLessThanOrEqual(SCENE_HEIGHT)
    })

    test("wordmark is centered horizontally within the 96px canvas", () => {
      const leftMargin: number = SCENE_LAYOUT.wordmark.x
      const rightMargin: number = SCENE_WIDTH - (SCENE_LAYOUT.wordmark.x + WORDMARK_SIZE.width)
      expect(leftMargin).toBe(rightMargin)
      expect(leftMargin).toBe(16 as number)
    })

    test("pot is centered in the upper composition", () => {
      const potCenter = SCENE_LAYOUT.pot.x + POT_SPRITE_SIZE.width / 2
      // Canvas center is 48
      expect(potCenter).toBe(48)
    })
  })

  describe("integer scale calculation", () => {
    test("calculates exact integer scale for viewports from 800x600 to 4K", () => {
      // 800x600 window: min(800/96, 600/54) = min(8.33, 11.11) -> 8
      expect(calculateIntegerScale(800, 600)).toBe(8)
      // 1024x768 window: min(10.66, 14.22) -> 10
      expect(calculateIntegerScale(1024, 768)).toBe(10)
      // 1080p (1920x1080): min(20, 20) -> 20
      expect(calculateIntegerScale(1920, 1080)).toBe(20)
      // 1440p (2560x1440): min(26.66, 26.66) -> 26
      expect(calculateIntegerScale(2560, 1440)).toBe(26)
      // 4K (3840x2160): min(40, 40) -> 40
      expect(calculateIntegerScale(3840, 2160)).toBe(40)
    })

    test("floor is always at least 1, even in tiny windows", () => {
      expect(calculateIntegerScale(50, 30)).toBe(1)
      expect(calculateIntegerScale(0, 0)).toBe(1)
      expect(calculateIntegerScale(-100, -50)).toBe(1)
    })
  })

  describe("timing cadences", () => {
    test("pot cadence is ~8 fps (125ms per frame)", () => {
      expect(POT_FRAME_INTERVAL_MS).toBe(125)
      expect(1000 / POT_FRAME_INTERVAL_MS).toBe(8)
    })

    test("developer cadence is 1s per pose (8s full cycle)", () => {
      expect(DEV_POSE_INTERVAL_MS).toBe(1000)
    })

    test("getActiveFrames computes correct indices at given elapsed times", () => {
      // At t = 0: frame 0, pose 0
      expect(getActiveFrames(0)).toEqual({ potFrameIndex: 0, devPoseIndex: 0 })

      // At t = 250ms (2 * 125ms): pot frame 2, pose 0
      expect(getActiveFrames(250)).toEqual({ potFrameIndex: 2, devPoseIndex: 0 })

      // At t = 1000ms: pot frame 0 (looped), pose 1 (mescola_sinistra)
      expect(getActiveFrames(1000)).toEqual({ potFrameIndex: 0, devPoseIndex: 1 })

      // At t = 6200ms: pot frame 1, pose 6 (pollice_su)
      expect(getActiveFrames(6200)).toEqual({ potFrameIndex: 1, devPoseIndex: 6 })

      // At t = 8000ms: full loop wraps back to 0, 0
      expect(getActiveFrames(8000)).toEqual({ potFrameIndex: 0, devPoseIndex: 0 })
    })
  })

  describe("scene rendering", () => {
    test("renderScene fills background with ink and draws elements", () => {
      const drawnRects: { x: number; y: number; w: number; h: number; fill: string }[] = []
      const fakeCtx = {
        fillStyle: "",
        fillRect: (x: number, y: number, w: number, h: number) => {
          drawnRects.push({ x, y, w, h, fill: String(fakeCtx.fillStyle) })
        },
      } as unknown as CanvasRenderingContext2D

      renderScene(fakeCtx, 0, 0)

      // First rect is the full background
      expect(drawnRects[0]).toEqual({
        x: 0,
        y: 0,
        w: SCENE_WIDTH,
        h: SCENE_HEIGHT,
        fill: INK_BACKGROUND,
      })

      // Multiple rects drawn for sprites and counter
      expect(drawnRects.length).toBeGreaterThan(100)
    })
  })

  describe("reduced motion and controller lifecycle", () => {
    test("when prefersReducedMotion is true, renders static frame and starts no loop", () => {
      let rAFCalled = false
      const origRAF = window.requestAnimationFrame
      window.requestAnimationFrame = () => {
        rAFCalled = true
        return 1
      }

      try {
        const canvas = document.createElement("canvas")
        let firstFrameCallbackCalled = false

        const controller = startPixelScene(canvas, {
          prefersReducedMotion: true,
          onFirstFrameRendered: () => {
            firstFrameCallbackCalled = true
          },
        })

        expect(firstFrameCallbackCalled).toBe(true)
        expect(rAFCalled).toBe(false)
        expect(canvas.width).toBe(SCENE_WIDTH)
        expect(canvas.height).toBe(SCENE_HEIGHT)

        controller.stop()
      } finally {
        window.requestAnimationFrame = origRAF
      }
    })

    test("calling stop cancels active animation frame and stops tick", () => {
      let cancelled = false
      const origCancel = window.cancelAnimationFrame
      window.cancelAnimationFrame = () => {
        cancelled = true
      }

      try {
        const canvas = document.createElement("canvas")
        const controller = startPixelScene(canvas)

        controller.resize(1920, 1080)
        expect(canvas.style.width).toBe(`${96 * 20}px`)
        expect(canvas.style.height).toBe(`${54 * 20}px`)

        controller.stop()
        expect(cancelled).toBe(true)
      } finally {
        window.cancelAnimationFrame = origCancel
      }
    })
  })
})
