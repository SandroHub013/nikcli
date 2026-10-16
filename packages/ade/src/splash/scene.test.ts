import { describe, expect, test } from "bun:test"
import {
  DEV_POSE_INTERVAL_MS,
  INK_BACKGROUND,
  POT_FRAME_INTERVAL_MS,
  SCENE_HEIGHT,
  SCENE_LAYOUT,
  SCENE_WIDTH,
  calculateIntegerScale,
  createStaticBackground,
  drawLadle,
  getActiveFrames,
  renderScene,
  startPixelScene,
} from "./scene"
import {
  BASIL_SIZE,
  BASIL_SPRITE,
  DEVELOPER_POSES,
  DEVELOPER_SPRITE_SIZE,
  LAPTOP_SIZE,
  LAPTOP_SPRITE,
  POT_FRAMES,
  POT_SPRITE_SIZE,
  SPLASH_PALETTE,
  TOMATO_SIZE,
  TOMATO_SPRITE,
  WORDMARK_GRID,
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

    test("calculates integer scale in physical device pixels using devicePixelRatio (P2-1)", () => {
      // 1920x1080 at 125% zoom (1536x826 CSS window):
      // device pixels: 1920x1032.5 -> floor(1920/160)=12, floor(1032.5/90)=11 -> scale 11
      expect(calculateIntegerScale(1536, 826, 1.25)).toBe(11)

      // 1366x768 at 125% zoom (1092.8x614.4 CSS window):
      // device pixels: 1366x768 -> floor(1366/160)=8, floor(768/90)=8 -> scale 8
      expect(calculateIntegerScale(1092.8, 614.4, 1.25)).toBe(8)

      // 1920x1080 full screen at 150% zoom (1280x720 CSS window):
      // device pixels: 1920x1080 -> scale 12
      expect(calculateIntegerScale(1280, 720, 1.5)).toBe(12)

      // 1080p full screen at 100% zoom (1920x1080, dpr 1.0):
      expect(calculateIntegerScale(1920, 1080, 1.0)).toBe(12)
    })

    test("resize sets integer-snapped dimensions and positioning for fractional DPR (P2-1)", () => {
      const canvas = document.createElement("canvas")
      const container = document.createElement("div")
      container.setAttribute("data-slot", "splash-scene-container")
      container.appendChild(canvas)
      document.body.appendChild(container)

      try {
        const controller = startPixelScene(canvas)
        const scale = controller.resize(1536, 826, 1.25)
        expect(scale).toBe(11)

        // CSS width: 160 * 11 / 1.25 = 1408px
        expect(canvas.style.width).toBe("1408px")
        // CSS height: 90 * 11 / 1.25 = 792px
        expect(canvas.style.height).toBe("792px")

        // Origin snapped to device pixel integer:
        // left in dev px = round((1536*1.25 - 160*11)/2) = round((1920 - 1760)/2) = 80px -> CSS 80/1.25 = 64px
        expect(container.style.left).toBe("64px")
        // top in dev px = round((826*1.25 - 90*11)/2) = round((1032.5 - 990)/2) = round(21.25) = 21px -> CSS 21/1.25 = 16.8px
        expect(container.style.top).toBe("16.8px")
        controller.stop()
      } finally {
        container.remove()
      }
    })

    test("sets --splash-scanline-period to exact 2 * scale in device pixels to prevent moiré (P3-6)", () => {
      const splash = document.createElement("div")
      splash.setAttribute("data-component", "ade-splash")
      const container = document.createElement("div")
      container.setAttribute("data-slot", "splash-scene-container")
      const canvas = document.createElement("canvas")
      container.appendChild(canvas)
      splash.appendChild(container)
      document.body.appendChild(splash)

      try {
        const controller = startPixelScene(canvas)
        // Scale 5 at DPR 1: 2 * 5 / 1 = 10px
        controller.resize(800, 600, 1)
        expect(splash.style.getPropertyValue("--splash-scanline-period")).toBe("10px")

        // Scale 11 at DPR 1.25 (1536x826): 2 * 11 / 1.25 = 17.6px (22 device pixels)
        controller.resize(1536, 826, 1.25)
        expect(splash.style.getPropertyValue("--splash-scanline-period")).toBe("17.6px")
        controller.stop()
      } finally {
        splash.remove()
      }
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

    test("createStaticBackground returns cached canvas with static elements (P2-2)", () => {
      const bg = createStaticBackground()
      expect(bg).not.toBeNull()
      expect(bg?.width).toBe(SCENE_WIDTH)
      expect(bg?.height).toBe(SCENE_HEIGHT)
    })

    test("renderScene uses static background drawImage when provided (P2-2)", () => {
      let drawImageCalls = 0
      let fillRectCalls = 0
      const fakeCtx = {
        fillStyle: "",
        fillRect: () => { fillRectCalls++ },
        drawImage: () => { drawImageCalls++ },
      } as unknown as CanvasRenderingContext2D

      const bg = createStaticBackground()
      renderScene(fakeCtx, 0, 0, bg)

      expect(drawImageCalls).toBe(1)
      expect(fillRectCalls).toBeLessThan(900)
    })

    test("animation loop redraws only when frame index changes (P2-2)", () => {
      let rAFCallback: ((now: number) => void) | null = null
      const origRAF = window.requestAnimationFrame
      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        rAFCallback = cb
        return 1
      }

      const canvas = document.createElement("canvas")
      let drawImageCalls = 0
      let fillRectCalls = 0
      const mockCtx = {
        fillStyle: "",
        fillRect: () => { fillRectCalls++ },
        drawImage: () => { drawImageCalls++ },
        imageSmoothingEnabled: false,
      }
      canvas.getContext = (() => mockCtx) as any

      const origPerf = performance.now
      let now = 1000
      performance.now = () => now

      try {
        const controller = startPixelScene(canvas)
        expect(rAFCallback).not.toBeNull()
        rAFCallback!(now)
        const initialDraws = drawImageCalls
        expect(initialDraws).toBe(1)

        // Second tick at now = 1016 (only 16ms later, same frame indices) -> no redraw
        expect(rAFCallback).not.toBeNull()
        now = 1016
        rAFCallback!(now)
        expect(drawImageCalls).toBe(initialDraws)

        // Third tick at now = 1130 (130ms later, elapsed crossed 125ms threshold) -> redraw
        expect(rAFCallback).not.toBeNull()
        now = 1130
        rAFCallback!(now)
        expect(drawImageCalls).toBe(initialDraws + 1)

        controller.stop()
      } finally {
        window.requestAnimationFrame = origRAF
        performance.now = origPerf
      }
    })

    test("ladle reaches into pot sauce in scene coordinates between [pot.x+7, pot.x+25] (P2-4)", () => {
      const drawnPixels: { x: number; y: number; color: string }[] = []
      const fakeCtx = {
        fillStyle: "",
        fillRect: (x: number, y: number, w: number, h: number) => {
          drawnPixels.push({ x, y, color: String(fakeCtx.fillStyle) })
        },
      } as unknown as CanvasRenderingContext2D

      // Test mescola sinistra (pose 1)
      const tipSinistra = drawLadle(fakeCtx, 1, SCENE_LAYOUT.pot.x, SCENE_LAYOUT.pot.y)
      expect(tipSinistra).not.toBeNull()
      expect(tipSinistra!.tipX).toBeGreaterThanOrEqual(SCENE_LAYOUT.pot.x + 7)
      expect(tipSinistra!.tipX).toBeLessThanOrEqual(SCENE_LAYOUT.pot.x + 25)
      expect(tipSinistra!.tipY).toBeGreaterThanOrEqual(SCENE_LAYOUT.pot.y + 14) // in sauce

      // Test mescola destra (pose 2)
      const tipDestra = drawLadle(fakeCtx, 2, SCENE_LAYOUT.pot.x, SCENE_LAYOUT.pot.y)
      expect(tipDestra).not.toBeNull()
      expect(tipDestra!.tipX).toBeGreaterThanOrEqual(SCENE_LAYOUT.pot.x + 7)
      expect(tipDestra!.tipX).toBeLessThanOrEqual(SCENE_LAYOUT.pot.x + 25)
      expect(tipDestra!.tipY).toBeGreaterThanOrEqual(SCENE_LAYOUT.pot.y + 14) // in sauce

      // Verify tip moved to the right between sinistra and destra (stirring motion)
      expect(tipDestra!.tipX).toBeGreaterThan(tipSinistra!.tipX)
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

    test("calling stop cancels active animation frame, cleans visibility listener, and halts tick (P2-3)", () => {
      const rAFQueue = new Map<number, FrameRequestCallback>()
      let nextId = 1
      const origRAF = window.requestAnimationFrame
      const origCancel = window.cancelAnimationFrame

      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        const id = nextId++
        rAFQueue.set(id, cb)
        return id
      }
      window.cancelAnimationFrame = (id: number) => {
        rAFQueue.delete(id)
      }

      let visibilityChangeListeners = 0
      const origAddDocListener = document.addEventListener
      const origRemoveDocListener = document.removeEventListener

      document.addEventListener = (event: string, cb: any, opts?: any) => {
        if (event === "visibilitychange") visibilityChangeListeners++
        return origAddDocListener.call(document, event, cb, opts)
      }
      document.removeEventListener = (event: string, cb: any, opts?: any) => {
        if (event === "visibilitychange") visibilityChangeListeners--
        return origRemoveDocListener.call(document, event, cb, opts)
      }

      let drawCalls = 0
      const canvas = document.createElement("canvas")
      const mockCtx = {
        fillStyle: "",
        fillRect: () => { drawCalls++ },
        drawImage: () => { drawCalls++ },
        imageSmoothingEnabled: false,
      }
      canvas.getContext = (() => mockCtx) as any

      try {
        const controller = startPixelScene(canvas)
        expect(visibilityChangeListeners).toBe(1)
        expect(rAFQueue.size).toBe(1)

        const [id, cb] = Array.from(rAFQueue.entries())[0]!

        controller.stop()
        // 1. cancelAnimationFrame was called and removed the frame from queue
        expect(rAFQueue.size).toBe(0)
        // 2. visibilitychange event listener was cleanly removed
        expect(visibilityChangeListeners).toBe(0)

        // 3. Even if a stale callback were invoked after stop, tick exits immediately without drawing or re-queueing
        const drawsBefore = drawCalls
        cb(1500)
        expect(drawCalls).toBe(drawsBefore)
        expect(rAFQueue.size).toBe(0)
      } finally {
        window.requestAnimationFrame = origRAF
        window.cancelAnimationFrame = origCancel
        document.addEventListener = origAddDocListener
        document.removeEventListener = origRemoveDocListener
      }
    })
  })

  describe("contrast against ink background (rev2 step 5)", () => {
    const channel = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    const luminance = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16) / 255
      const g = parseInt(hex.slice(3, 5), 16) / 255
      const b = parseInt(hex.slice(5, 7), 16) / 255
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const contrastRatio = (hex1: string, hex2: string) => {
      const l1 = luminance(hex1)
      const l2 = luminance(hex2)
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }

    test("every non-transparent pixel in the wordmark has contrast >= 1.5 against ink background", () => {
      let count = 0
      for (const row of WORDMARK_GRID) {
        for (const pixel of row) {
          if (!pixel) continue
          count++
          const cr = contrastRatio(pixel, INK_BACKGROUND)
          expect(cr).toBeGreaterThanOrEqual(1.5)
        }
      }
      expect(count).toBeGreaterThan(100)
    })

    test("every non-transparent pixel in developer poses has contrast >= 1.5 against ink background", () => {
      let count = 0
      for (const pose of DEVELOPER_POSES) {
        for (const row of pose) {
          for (const char of row) {
            if (char === ".") continue
            count++
            const color = SPLASH_PALETTE[char]!
            const cr = contrastRatio(color, INK_BACKGROUND)
            expect(cr).toBeGreaterThanOrEqual(1.5)
          }
        }
      }
      expect(count).toBeGreaterThan(1000)
    })

    test("every non-transparent pixel in pot frames has contrast >= 1.5 against ink background", () => {
      let count = 0
      for (const frame of POT_FRAMES) {
        for (const row of frame) {
          for (const char of row) {
            if (char === ".") continue
            count++
            const color = SPLASH_PALETTE[char]!
            const cr = contrastRatio(color, INK_BACKGROUND)
            expect(cr).toBeGreaterThanOrEqual(1.5)
          }
        }
      }
      expect(count).toBeGreaterThan(1000)
    })

    test("every non-transparent pixel in props (laptop, tomato, basil) has contrast >= 1.5 against ink background (P3-5)", () => {
      let count = 0
      for (const sprite of [LAPTOP_SPRITE, TOMATO_SPRITE, BASIL_SPRITE]) {
        for (const row of sprite) {
          for (const char of row) {
            if (char === ".") continue
            count++
            const color = SPLASH_PALETTE[char]!
            const cr = contrastRatio(color, INK_BACKGROUND)
            expect(cr).toBeGreaterThanOrEqual(1.5)
          }
        }
      }
      expect(count).toBeGreaterThan(100)
    })
  })
})
