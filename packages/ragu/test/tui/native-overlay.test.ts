import { describe, expect, test } from "bun:test"
import type { CliRenderer } from "@opentui/core"
import {
  eraseOverlayRect,
  eraseTerminal,
  fitOverlayCells,
  overlayFullyVisible,
  overlayRectsEqual,
  paintOverlay,
  registerNativeOverlay,
} from "@tui/util/native-overlay"

function fakeRenderer(width = 80, height = 24) {
  const writes: string[] = []
  let gridPaints = 0
  let fullPaints = 0
  const host = {
    terminalWidth: width,
    terminalHeight: height,
    renderOffset: 0,
    forceFullRepaintRequested: undefined as boolean | undefined,
    requestRender() {
      host.renderNative()
    },
    renderNative() {
      gridPaints++
      if (host.forceFullRepaintRequested) fullPaints++
      host.forceFullRepaintRequested = false
    },
    writeOut(chunk: string) {
      writes.push(chunk)
    },
  }
  return { renderer: host as unknown as CliRenderer, host, writes, grid: () => gridPaints, full: () => fullPaints }
}

describe("fitOverlayCells", () => {
  test("fills the cell box exactly so xterm.js has no checkerboard slack", () => {
    const fitted = fitOverlayCells(1920, 1080, { columns: 80, rows: 40 }, { width: 10, height: 20 })
    expect(fitted.columns).toBe(80)
    expect(fitted.rows).toBe(23)
    expect(fitted.pixelWidth).toBe(800)
    expect(fitted.pixelHeight % 6).toBe(0)
    expect(fitted.pixelHeight).toBeLessThanOrEqual(23 * 20)
    expect(fitted.pixelWidth / fitted.pixelHeight).toBeCloseTo(1920 / 1080, 1)
  })

  test("does not upscale a small image's cell box", () => {
    const fitted = fitOverlayCells(20, 10, { columns: 80, rows: 40 }, { width: 10, height: 20 })
    expect(fitted.columns).toBe(2)
    expect(fitted.rows).toBe(1)
    expect(fitted.pixelWidth).toBe(20)
  })
})

describe("overlayFullyVisible", () => {
  test("rejects rectangles whose origin is off the terminal", () => {
    expect(overlayFullyVisible({ x: 0, y: 0, columns: 10, rows: 5 }, 80, 24)).toBe(true)
    expect(overlayFullyVisible({ x: -1, y: 0, columns: 10, rows: 5 }, 80, 24)).toBe(false)
    expect(overlayFullyVisible({ x: 0, y: 24, columns: 10, rows: 5 }, 80, 24)).toBe(false)
    // A live WebView is often a couple of rows taller than the panel. That
    // overflow must still paint, or the page appears and then vanishes.
    expect(overlayFullyVisible({ x: 0, y: 20, columns: 10, rows: 5 }, 80, 24)).toBe(true)
  })

  test("keeps the prompt chrome clear", () => {
    expect(overlayFullyVisible({ x: 0, y: 18, columns: 10, rows: 5 }, 80, 24, 3)).toBe(false)
    expect(overlayFullyVisible({ x: 0, y: 16, columns: 10, rows: 5 }, 80, 24, 3)).toBe(true)
  })
})

describe("eraseOverlayRect", () => {
  test("emits ECH then spaces so the image addon cannot leave a checkerboard", () => {
    const sequence = eraseOverlayRect({ x: 2, y: 3, columns: 10, rows: 2 }, 80, 24)
    expect(sequence).toContain("\x1b[4;3H\x1b[10X" + " ".repeat(10))
    expect(sequence).toContain("\x1b[5;3H\x1b[10X" + " ".repeat(10))
    expect(sequence.startsWith("\x1b7")).toBe(true)
    expect(sequence.endsWith("\x1b8")).toBe(true)
  })

  test("clips erase to the terminal instead of writing off-screen CUP", () => {
    const sequence = eraseOverlayRect({ x: 78, y: -1, columns: 10, rows: 4 }, 80, 24)
    expect(sequence).toContain("\x1b[1;79H\x1b[2X  ")
    expect(sequence).not.toContain("\x1b[0;")
  })

  test("wipes every row so a Sixel that overflowed its box cannot survive Esc", () => {
    const sequence = eraseTerminal(80, 24)
    expect(sequence).toContain("\x1b[1;1H\x1b[80X")
    expect(sequence).toContain("\x1b[24;1H\x1b[80X")
    expect(sequence).toContain(" ".repeat(80))
  })

  test("does not CSI-erase the prompt chrome", () => {
    const sequence = eraseOverlayRect({ x: 0, y: 20, columns: 10, rows: 5 }, 80, 24, 3)
    expect(sequence).toContain("\x1b[21;1H")
    expect(sequence).not.toContain("\x1b[23;1H")
    expect(sequence).not.toContain("\x1b[24;1H")
    expect(sequence).not.toContain("\x1b[25;1H")
  })
})

describe("overlayRectsEqual", () => {
  test("compares origin and size", () => {
    const rect = { x: 1, y: 2, columns: 3, rows: 4 }
    expect(overlayRectsEqual(rect, { ...rect })).toBe(true)
    expect(overlayRectsEqual(rect, { ...rect, y: 3 })).toBe(false)
  })
})

describe("registerNativeOverlay", () => {
  test("cleanup triggered during inline output erases the emitted placement", () => {
    const { renderer, writes } = fakeRenderer()
    let release = () => {}
    release = registerNativeOverlay(renderer, {
      box: { x: 2, y: 0 },
      bytes: "OSC1337",
      columns: 10,
      rows: 5,
      inline: true,
      writer: (chunk) => {
        writes.push(chunk)
        if (chunk.includes("OSC1337")) release()
      },
    })
    renderer.requestRender()
    expect(writes).toEqual([
      paintOverlay({ x: 2, y: 0, columns: 10, rows: 5 }, "OSC1337"),
      eraseOverlayRect({ x: 2, y: 0, columns: 10, rows: 5 }, 80, 24),
    ])
  })
  test("does not paint an unattached image at y=0 while awaiting its chat viewport", () => {
    const { renderer, writes } = fakeRenderer()
    let viewport: { x: number; y: number; columns: number; rows: number } | undefined
    const overlay = {
      box: { x: 2, y: 0 },
      bytes: "OSC1337",
      columns: 10,
      rows: 5,
      inline: true,
      viewport: () => viewport,
    }
    const release = registerNativeOverlay(renderer, overlay)
    for (let frame = 0; frame < 100; frame++) renderer.requestRender()
    expect(writes).toEqual([])
    viewport = { x: 2, y: 6, columns: 70, rows: 16 }
    overlay.box.y = 6
    renderer.requestRender()
    renderer.requestRender()
    expect(writes).toEqual([paintOverlay({ x: 2, y: 6, columns: 10, rows: 5 }, "OSC1337")])
    release()
  })
  test("emits one OSC 1337 placement over 100 identical frames", () => {
    const { renderer, writes } = fakeRenderer()
    const bytes = "\x1b]1337;File=inline=1;size=1:YQ==\x07"
    const release = registerNativeOverlay(renderer, { box: { x: 2, y: 3 }, bytes, columns: 10, rows: 5, inline: true })
    for (let frame = 0; frame < 100; frame++) renderer.requestRender()
    expect(writes.filter((chunk) => chunk.includes("\x1b]1337;File=")).length).toBe(1)
    release()
  })

  test("moving y erases the previous placement then emits exactly once", () => {
    const { renderer, writes } = fakeRenderer()
    const bytes = "\x1b]1337;File=inline=1;size=1:YQ==\x07"
    const overlay = { box: { x: 2, y: 3 }, bytes, columns: 10, rows: 5, inline: true }
    const release = registerNativeOverlay(renderer, overlay)
    renderer.requestRender()
    writes.length = 0
    overlay.box.y = 10
    for (let frame = 0; frame < 10; frame++) renderer.requestRender()
    expect(writes).toEqual([
      eraseOverlayRect({ x: 2, y: 3, columns: 10, rows: 5 }, 80, 24),
      paintOverlay({ x: 2, y: 10, columns: 10, rows: 5 }, bytes),
    ])
    release()
  })

  test("mount waits for a stable layout and never paints the transient top row", () => {
    const { renderer, writes } = fakeRenderer()
    const overlay = { box: { x: 2, y: 0 }, bytes: "OSC1337", columns: 10, rows: 5, inline: true }
    const release = registerNativeOverlay(renderer, overlay)
    expect(writes).toEqual([])
    overlay.box.y = 10
    renderer.requestRender()
    expect(writes).toEqual([])
    renderer.requestRender()
    expect(writes).toEqual([paintOverlay({ x: 2, y: 10, columns: 10, rows: 5 }, "OSC1337")])
    release()
  })

  test("resize and full clear invalidate a placement only once", () => {
    const { renderer, host, writes } = fakeRenderer()
    const release = registerNativeOverlay(renderer, {
      box: { x: 2, y: 3 },
      bytes: "OSC1337",
      columns: 10,
      rows: 5,
      inline: true,
    })
    renderer.requestRender()
    writes.length = 0
    host.terminalWidth = 90
    for (let frame = 0; frame < 10; frame++) renderer.requestRender()
    expect(writes.filter((chunk) => chunk.includes("OSC1337"))).toHaveLength(1)
    writes.length = 0
    host.forceFullRepaintRequested = true
    for (let frame = 0; frame < 10; frame++) renderer.requestRender()
    expect(writes.filter((chunk) => chunk.includes("OSC1337"))).toHaveLength(1)
    release()
  })

  test("payload or dimensions updates invalidate the inline placement", () => {
    const { renderer, writes } = fakeRenderer()
    const overlay = { box: { x: 2, y: 3 }, bytes: "OSC1337", columns: 10, rows: 5, inline: true }
    const release = registerNativeOverlay(renderer, overlay)
    renderer.requestRender()
    writes.length = 0
    overlay.bytes = "OSC1337-new"
    for (let frame = 0; frame < 10; frame++) renderer.requestRender()
    expect(writes).toEqual([paintOverlay({ x: 2, y: 3, columns: 10, rows: 5 }, overlay.bytes)])
    writes.length = 0
    overlay.columns = 12
    for (let frame = 0; frame < 10; frame++) renderer.requestRender()
    expect(writes).toEqual([
      eraseOverlayRect({ x: 2, y: 3, columns: 10, rows: 5 }, 80, 24),
      paintOverlay({ x: 2, y: 3, columns: 12, rows: 5 }, overlay.bytes),
    ])
    release()
  })
  test("inline overlays follow the box, skip clipped rows and clean only their last rectangle", () => {
    const { renderer, full, writes } = fakeRenderer(80, 24)
    const overlay = {
      box: { x: 2, y: 3 },
      bytes: "OSC1337",
      columns: 10,
      rows: 5,
      inline: true,
      viewport: () => ({ x: 0, y: 2, columns: 70, rows: 16 }),
    }
    const release = registerNativeOverlay(renderer, overlay)
    renderer.requestRender()
    expect(writes.at(-1)).toBe(paintOverlay({ x: 2, y: 3, columns: 10, rows: 5 }, "OSC1337"))
    writes.length = 0
    overlay.box.y = 16
    renderer.requestRender()
    expect(writes[0]).toBe(eraseOverlayRect({ x: 2, y: 3, columns: 10, rows: 5 }, 80, 24))
    expect(writes.some((chunk) => chunk.includes("OSC1337"))).toBe(false)
    expect(full()).toBeGreaterThan(0)
    overlay.box.y = 5
    renderer.requestRender()
    renderer.requestRender()
    writes.length = 0
    release()
    expect(writes[0]).toBe(eraseOverlayRect({ x: 2, y: 5, columns: 10, rows: 5 }, 80, 24))
    expect(writes[0]).not.toBe(eraseTerminal(80, 24))
  })

  test("writer failure disables native output and preserves the grid fallback", () => {
    const { renderer, host, grid } = fakeRenderer()
    let failed = false
    const release = registerNativeOverlay(renderer, {
      box: { x: 2, y: 3 },
      bytes: "OSC1337",
      columns: 10,
      rows: 5,
      inline: true,
      writer: () => {
        throw new Error("closed output")
      },
      onError: () => {
        failed = true
      },
    })
    renderer.requestRender()
    expect(failed).toBe(true)
    expect(grid()).toBe(2)
    expect(host.forceFullRepaintRequested).toBe(true)
    release()
  })

  test("dialog visibility disables painting without wiping the terminal", () => {
    const { renderer, writes } = fakeRenderer()
    let enabled = true
    const release = registerNativeOverlay(renderer, {
      box: { x: 2, y: 3 },
      bytes: "OSC1337",
      columns: 10,
      rows: 5,
      inline: true,
      enabled: () => enabled,
    })
    renderer.requestRender()
    enabled = false
    writes.length = 0
    renderer.requestRender()
    expect(writes.some((chunk) => chunk.includes("OSC1337"))).toBe(false)
    release()
  })
  test("paints after the grid and erases on unregister", () => {
    const { renderer, full, writes, grid } = fakeRenderer()
    const overlay = { box: { x: 2, y: 3 }, bytes: "SIXEL", columns: 10, rows: 5 }
    const unregister = registerNativeOverlay(renderer, overlay)

    expect(grid()).toBe(1)
    expect(writes.at(-1)).toBe(paintOverlay({ x: 2, y: 3, columns: 10, rows: 5 }, "SIXEL"))

    writes.length = 0
    unregister()
    expect(writes[0]).toBe(eraseTerminal(80, 24))
    expect(writes[0]).toContain(" ".repeat(80))
    expect(full()).toBeGreaterThan(0)
  })

  test("does not erase on a same-place redraw", () => {
    const { renderer, writes } = fakeRenderer()
    const overlay = { box: { x: 2, y: 3 }, bytes: "SIXEL", columns: 10, rows: 5 }
    registerNativeOverlay(renderer, overlay)

    writes.length = 0
    overlay.bytes = "SIXEL2"
    renderer.requestRender()

    expect(writes.some((chunk) => chunk.includes("\x1b[10X"))).toBe(false)
    expect(writes.at(-1)).toBe(paintOverlay({ x: 2, y: 3, columns: 10, rows: 5 }, "SIXEL2"))
  })

  test("erases the last rectangle instead of painting when the box leaves the screen", () => {
    const { renderer, writes } = fakeRenderer()
    const overlay = { box: { x: 2, y: 3 }, bytes: "SIXEL", columns: 10, rows: 5 }
    registerNativeOverlay(renderer, overlay)

    overlay.box.y = 24
    writes.length = 0
    renderer.requestRender()

    expect(writes[0]).toBe(eraseOverlayRect({ x: 2, y: 3, columns: 10, rows: 5 }, 80, 24))
    expect(writes.some((chunk) => chunk.includes("SIXEL"))).toBe(false)
  })

  test("still paints a live view that overflows the terminal by a couple of rows", () => {
    const { renderer, writes } = fakeRenderer(80, 24)
    const overlay = { box: { x: 2, y: 20 }, bytes: "SIXEL", columns: 10, rows: 5 }
    registerNativeOverlay(renderer, overlay)
    expect(writes.at(-1)).toBe(paintOverlay({ x: 2, y: 20, columns: 10, rows: 5 }, "SIXEL"))
  })

  test("does not paint over the prompt chrome", () => {
    const { renderer, writes } = fakeRenderer(80, 24)
    const overlay = { box: { x: 2, y: 18 }, bytes: "SIXEL", columns: 10, rows: 5, chromeBottom: 3 }
    registerNativeOverlay(renderer, overlay)
    expect(writes.some((chunk) => chunk.includes("SIXEL"))).toBe(false)
  })

  test("erases the box on unregister even if it never painted", () => {
    const { renderer, full, writes } = fakeRenderer(80, 24)
    const overlay = { box: { x: 2, y: 24 }, bytes: "SIXEL", columns: 10, rows: 5 }
    const unregister = registerNativeOverlay(renderer, overlay)
    expect(writes.some((chunk) => chunk.includes("SIXEL"))).toBe(false)

    writes.length = 0
    unregister()
    expect(writes[0]).toBe(eraseTerminal(80, 24))
    expect(full()).toBeGreaterThan(0)
  })
})
