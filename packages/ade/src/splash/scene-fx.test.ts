import { describe, expect, test } from "bun:test"
import {
  B,
  POT,
  createFxState,
  drawFx,
  inPot,
  snap,
  spawnFx,
} from "./scene-fx"
import { startPixelScene } from "./scene"

describe("splash scene FX animation (Passo 3)", () => {
  test("block snap aligns values to multiples of 8", () => {
    expect(snap(0)).toBe(0)
    expect(snap(4)).toBe(8)
    expect(snap(7)).toBe(8)
    expect(snap(11)).toBe(8)
    expect(snap(15)).toBe(16)
  })

  test("inPot generates coordinates inside the cooking pot ellipse", () => {
    for (let i = 0; i < 50; i++) {
      const [x, y] = inPot()
      const dx = (x - POT.cx) / POT.rx
      const dy = (y - POT.cy) / POT.ry
      expect(dx * dx + dy * dy).toBeLessThanOrEqual(1.0001)
    }
  })

  test("createFxState initializes empty entity lists and future blink timer", () => {
    const state = createFxState(1000)
    expect(state.bubbles.length).toBe(0)
    expect(state.drops.length).toBe(0)
    expect(state.puffs.length).toBe(0)
    expect(state.sparks.length).toBe(0)
    expect(state.nextBlink).toBeGreaterThanOrEqual(3500)
  })

  test("spawnFx creates bubbles, steam puffs, sparkles, and blink over time", () => {
    const state = createFxState(0)
    spawnFx(state, 100)
    expect(state.bubbles.length).toBeGreaterThan(0)
    expect(state.puffs.length).toBeGreaterThan(0)
    expect(state.sparks.length).toBeGreaterThan(0)

    // Trigger blink
    state.nextBlink = 500
    spawnFx(state, 600)
    expect(state.blinkUntil).toBe(740)
  })

  test("drawFx renders effects onto 2D canvas context", () => {
    const state = createFxState(0)
    spawnFx(state, 100)

    const draws: Array<{ type: string; color?: any; x?: number; y?: number; w?: number; h?: number }> = []
    const ctx = {
      fillStyle: "",
      globalAlpha: 1,
      clearRect: () => draws.push({ type: "clear" }),
      fillRect: (x: number, y: number, w: number, h: number) => {
        draws.push({ type: "fill", color: ctx.fillStyle, x, y, w, h })
      },
    } as unknown as CanvasRenderingContext2D

    drawFx(ctx, state, 150, 1672, 941)
    expect(draws.some((d) => d.type === "clear")).toBe(true)
    expect(draws.some((d) => d.type === "fill")).toBe(true)

    // Laptop cursor check (green #5fa83a at 440, 456)
    // At now=150, floor(150 / 530) % 2 === 0 -> cursor is rendered
    const cursor = draws.find((d) => d.color === "#5fa83a" && d.x === 440 && d.y === 456)
    expect(cursor).toBeDefined()
  })

  test("startPixelScene with prefersReducedMotion renders no loop and leaves canvas clear", () => {
    const canvas = document.createElement("canvas")
    canvas.setAttribute("data-slot", "splash-canvas")
    const cleared: boolean[] = []
    canvas.getContext = (() => ({
      imageSmoothingEnabled: true,
      clearRect: () => cleared.push(true),
    })) as any

    let firstFrameFired = false
    const controller = startPixelScene(canvas, {
      prefersReducedMotion: true,
      onFirstFrameRendered: () => {
        firstFrameFired = true
      },
    })

    expect(firstFrameFired).toBe(true)
    expect(cleared.length).toBeGreaterThanOrEqual(1)
    controller.stop()
  })

  test("startPixelScene stop cancels active frame and unregisters visibilitychange (P2-2)", () => {
    let activeRafId: number | null = null
    let cancelledRafId: number | null = null
    let nextId = 500

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
      canvas.setAttribute("data-slot", "splash-canvas")
      canvas.getContext = (() => ({
        imageSmoothingEnabled: true,
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
})
