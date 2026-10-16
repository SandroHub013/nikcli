import { describe, expect, test } from "bun:test"
import {
  DEV_POSE_INTERVAL_MS,
  INK_BACKGROUND,
  POT_FRAME_INTERVAL_MS,
  SCENE_HEIGHT,
  SCENE_LAYOUT,
  SCENE_WIDTH,
  calculateIntegerScale,
  getActiveFrames,
  renderScene,
  startPixelScene,
} from "./scene"
import {
  BASIL_SIZE,
  DEVELOPER_SPRITE_SIZE,
  LAPTOP_SIZE,
  POT_SPRITE_SIZE,
  TOMATO_SIZE,
  WORDMARK_SIZE,
} from "./sprites"

describe("splash scene renderer (step 2)", () => {
  describe("scene dimensions and layout bounds", () => {
    test("logical dimensions are 160x90 with exact 16:9 aspect ratio", () => {
      expect(SCENE_WIDTH).toBe(160)
      expect(SCENE_HEIGHT).toBe(90)
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

      // Tomato & Basil
      expect(SCENE_LAYOUT.tomato.x + TOMATO_SIZE.width).toBeLessThanOrEqual(SCENE_WIDTH)
      expect(SCENE_LAYOUT.basil.x + BASIL_SIZE.width).toBeLessThanOrEqual(SCENE_WIDTH)

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

    test("wordmark spans 50% of the canvas width (80px) and is centered horizontally", () => {
      const ratio = WORDMARK_SIZE.width / SCENE_WIDTH
      expect(ratio).toBe(0.5)

      const leftMargin: number = SCENE_LAYOUT.wordmark.x
      const rightMargin: number = SCENE_WIDTH - (SCENE_LAYOUT.wordmark.x + WORDMARK_SIZE.width)
      expect(leftMargin).toBe(rightMargin)
      expect(leftMargin).toBe(40)
    })

    test("wordmark is placed 6-8 pixels below the kitchen counter line", () => {
      const gap = SCENE_LAYOUT.wordmark.y - SCENE_LAYOUT.counter.y
      expect(gap).toBeGreaterThanOrEqual(6)
      expect(gap).toBeLessThanOrEqual(8)
      expect(gap).toBe(7)
    })

    test("entire scene is unified into a single vertically centered composition", () => {
      const topPadding = SCENE_LAYOUT.developer.y
      const bottomPadding = SCENE_HEIGHT - (SCENE_LAYOUT.wordmark.y + WORDMARK_SIZE.height)
      // Top padding is around 12px, bottom padding is around 17px (well balanced across 90px)
      expect(topPadding).toBeGreaterThanOrEqual(10)
      expect(bottomPadding).toBeGreaterThanOrEqual(14)
      expect(Math.abs(topPadding - bottomPadding)).toBeLessThanOrEqual(6)
    })
  })

  describe("integer scale calculation", () => {
    test("calculates exact integer scale for viewports from 800x600 to 4K", () => {
      // 800x600 window: min(800/160, 600/90) = min(5, 6.66) -> 5
      expect(calculateIntegerScale(800, 600)).toBe(5)
      // 1024x768 window: min(1024/160, 768/90) = min(6.4, 8.53) -> 6
      expect(calculateIntegerScale(1024, 768)).toBe(6)
      // 1080p (1920x1080): min(12, 12) -> 12
      expect(calculateIntegerScale(1920, 1080)).toBe(12)
      // 1440p (2560x1440): min(16, 16) -> 16
      expect(calculateIntegerScale(2560, 1440)).toBe(16)
      // 4K (3840x2160): min(24, 24) -> 24
      expect(calculateIntegerScale(3840, 2160)).toBe(24)
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
      expect(getActiveFrames(0)).toEqual({ potFrameIndex: 0, devPoseIndex: 0 })
      expect(getActiveFrames(250)).toEqual({ potFrameIndex: 2, devPoseIndex: 0 })
      expect(getActiveFrames(1000)).toEqual({ potFrameIndex: 0, devPoseIndex: 1 })
      expect(getActiveFrames(6200)).toEqual({ potFrameIndex: 1, devPoseIndex: 6 })
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

      expect(drawnRects[0]).toEqual({
        x: 0,
        y: 0,
        w: SCENE_WIDTH,
        h: SCENE_HEIGHT,
        fill: INK_BACKGROUND,
      })

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
        expect(canvas.style.width).toBe(`${160 * 12}px`)
        expect(canvas.style.height).toBe(`${90 * 12}px`)

        controller.stop()
        expect(cancelled).toBe(true)
      } finally {
        window.cancelAnimationFrame = origCancel
      }
    })
  })
})
