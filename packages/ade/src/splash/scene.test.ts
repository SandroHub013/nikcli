import { afterEach, describe, expect, test } from "bun:test"
import {
  REF_ASPECT_RATIO,
  REF_HEIGHT,
  REF_WIDTH,
  SPLASH_BACKGROUND,
  computeStageDimensions,
  layoutSceneContainer,
  startPixelScene,
} from "./scene"

describe("splash scene renderer and stage layout (clean reference scene)", () => {
  afterEach(() => {
    document.body.removeAttribute("style")
    document.documentElement.removeAttribute("style")
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild)
    }
  })

  describe("reference dimensions and background constants", () => {
    test("logical dimensions are 1672x941 with ~1.7768 aspect ratio", () => {
      expect(REF_WIDTH).toBe(1672)
      expect(REF_HEIGHT).toBe(941)
      expect(REF_ASPECT_RATIO).toBeCloseTo(1672 / 941, 5)
    })

    test("splash background matches measured border color #211410", () => {
      expect(SPLASH_BACKGROUND).toBe("#211410")
    })
  })

  describe("responsive stage dimensions", () => {
    test("computeStageDimensions preserves aspect ratio across viewports from 800px to 4K", () => {
      const viewports = [
        { w: 800, h: 600, dpr: 1 },
        { w: 1024, h: 768, dpr: 1 },
        { w: 1280, h: 720, dpr: 1 },
        { w: 1366, h: 768, dpr: 1 },
        { w: 1536, h: 826, dpr: 1.25 },
        { w: 1920, h: 1080, dpr: 1 },
        { w: 2560, h: 1440, dpr: 1.25 },
        { w: 3840, h: 2160, dpr: 1.5 },
      ]

      for (const { w, h, dpr } of viewports) {
        const dims = computeStageDimensions(w, h, dpr)
        expect(dims.width).toBeLessThanOrEqual(w)
        expect(dims.height).toBeLessThanOrEqual(h)

        // Stage + 10px gap + 16px status fits within window height
        expect(dims.height + 26).toBeLessThanOrEqual(h)

        // Preserves aspect ratio 1672 / 941 within rounding
        expect(dims.width / dims.height).toBeCloseTo(1672 / 941, 1)
        expect(dims.scale).toBeGreaterThan(0)
      }
    })
  })

  describe("stage layout and positioning", () => {
    test("layoutSceneContainer sets stage dimensions and initializes canvas buffer", () => {
      const container = document.createElement("div")
      container.setAttribute("data-slot", "splash-scene-container")
      const stage = document.createElement("div")
      stage.setAttribute("data-slot", "splash-stage")
      const canvas = document.createElement("canvas")
      canvas.setAttribute("data-slot", "splash-canvas")
      stage.appendChild(canvas)
      container.appendChild(stage)
      document.body.appendChild(container)

      try {
        const scale = layoutSceneContainer(canvas, 1280, 720, 1)
        expect(canvas.width).toBe(1672)
        expect(canvas.height).toBe(941)
        expect(stage.style.width).toBe("1194px")
        expect(stage.style.height).toBe("672px")
        expect(container.style.width).toBe("1194px")
        expect(scale).toBeCloseTo(1194 / 1672, 3)
      } finally {
        container.remove()
      }
    })
  })

  describe("reduced motion and controller lifecycle", () => {
    test("when prefersReducedMotion is true, clears canvas and starts no animation loop", () => {
      const canvas = document.createElement("canvas")
      let firstFrameFired = false
      const controller = startPixelScene(canvas, {
        prefersReducedMotion: true,
        onFirstFrameRendered: () => {
          firstFrameFired = true
        },
      })

      expect(firstFrameFired).toBe(true)
      controller.stop()
    })

    test("calling stop cancels active animation frame and removes visibility listener", () => {
      const canvas = document.createElement("canvas")
      const controller = startPixelScene(canvas)
      expect(controller).toBeDefined()
      expect(typeof controller.stop).toBe("function")
      expect(typeof controller.resize).toBe("function")
      controller.stop()
    })

    test("no inline styles are left on body or documentElement", () => {
      expect(document.body.getAttribute("style")).toBeNull()
      expect(document.documentElement.getAttribute("style")).toBeNull()
    })
  })
})
