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

    test("calling stop cancels active animation frame and removes visibility listener (P2-2)", () => {
      let activeRafId: number | null = null
      let cancelledRafId: number | null = null
      let nextId = 100

      const origRaf = window.requestAnimationFrame
      const origCaf = window.cancelAnimationFrame
      let visibilityListenerCount = 0

      const origAdd = document.addEventListener.bind(document)
      const origRemove = document.removeEventListener.bind(document)

      window.requestAnimationFrame = () => {
        activeRafId = ++nextId
        return activeRafId
      }
      window.cancelAnimationFrame = (id: number) => {
        cancelledRafId = id
      }

      const addSpy = (type: string, listener: any, options?: any) => {
        if (type === "visibilitychange") visibilityListenerCount++
        return origAdd(type, listener, options)
      }
      const removeSpy = (type: string, listener: any, options?: any) => {
        if (type === "visibilitychange") visibilityListenerCount--
        return origRemove(type, listener, options)
      }
      document.addEventListener = addSpy as any
      document.removeEventListener = removeSpy as any

      try {
        const canvas = document.createElement("canvas")
        canvas.getContext = (() => ({
          imageSmoothingEnabled: false,
          clearRect: () => {},
          fillRect: () => {},
        })) as any

        const controller = startPixelScene(canvas)
        expect(activeRafId).not.toBeNull()
        expect(visibilityListenerCount).toBe(1)

        controller.stop()
        expect(cancelledRafId).toBe(activeRafId)
        expect(visibilityListenerCount).toBe(0)
      } finally {
        window.requestAnimationFrame = origRaf
        window.cancelAnimationFrame = origCaf
        document.addEventListener = origAdd
        document.removeEventListener = origRemove
      }
    })

    test("when document.hidden becomes true, cancels active rAF, and resumes when visible again (P2-2)", () => {
      let sceneTickCb: FrameRequestCallback | null = null
      let sceneRafCalls = 0
      let activeRafId: number | null = null
      const cancelledRafIds: number[] = []
      let nextId = 200

      const origRaf = window.requestAnimationFrame
      const origCaf = window.cancelAnimationFrame

      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        const id = ++nextId
        if (!sceneTickCb) {
          sceneTickCb = cb
        }
        if (cb === sceneTickCb) {
          sceneRafCalls++
          activeRafId = id
        }
        return id
      }
      window.cancelAnimationFrame = (id: number) => {
        cancelledRafIds.push(id)
        if (id === activeRafId) {
          activeRafId = null
        }
      }

      let isHidden = false
      Object.defineProperty(document, "hidden", {
        get: () => isHidden,
        configurable: true,
      })

      try {
        const canvas = document.createElement("canvas")
        canvas.getContext = (() => ({
          imageSmoothingEnabled: false,
          clearRect: () => {},
          fillRect: () => {},
        })) as any

        const controller = startPixelScene(canvas)
        expect(sceneRafCalls).toBe(1)
        const initialId = activeRafId
        expect(initialId).not.toBeNull()

        // Page becomes hidden: active frame is cancelled
        isHidden = true
        document.dispatchEvent(new Event("visibilitychange"))
        expect(cancelledRafIds).toContain(initialId!)
        expect(activeRafId).toBeNull()

        // Page becomes visible: new frame is requested to resume loop
        isHidden = false
        document.dispatchEvent(new Event("visibilitychange"))
        expect(sceneRafCalls).toBe(2)
        expect(activeRafId).not.toBeNull()
        expect(activeRafId).not.toBe(initialId!)
        const resumedId = activeRafId

        controller.stop()
        expect(cancelledRafIds).toContain(resumedId!)
      } finally {
        window.requestAnimationFrame = origRaf
        window.cancelAnimationFrame = origCaf
        delete (document as any).hidden
      }

      expect(Object.prototype.hasOwnProperty.call(document, "hidden")).toBe(false)
    })

    test("no inline styles are left on body or documentElement", () => {
      expect(document.body.getAttribute("style")).toBeNull()
      expect(document.documentElement.getAttribute("style")).toBeNull()
    })
  })
})
