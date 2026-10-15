import { describe, expect, test } from "bun:test"
import { ScrollBoxRenderable } from "@opentui/core"
import { chooseInlineImageRenderer, jimpDecoder, Protocol, rgbaToPng, type Capabilities } from "@ragu/tui-image"
import { extractTuiImageUrls, inlineImageViewport, loadTuiImage, toCellGrid } from "@tui/component/tui-image"

function caps(overrides: Partial<Capabilities> & Pick<Capabilities, "terminal">): Capabilities {
  return {
    best: Protocol.KITTY,
    available: [Protocol.KITTY],
    kitty: true,
    sixel: false,
    iterm2: false,
    ...overrides,
  }
}

describe("chooseInlineImageRenderer", () => {
  test("uses placeholders only when the terminal composites them", () => {
    expect(chooseInlineImageRenderer(caps({ terminal: "xterm-kitty" }), {})).toBe("kitty")
    expect(chooseInlineImageRenderer(caps({ terminal: "ghostty" }), {})).toBe("kitty")
  })

  test("falls back to half-blocks when DA1 advertised Sixel — overlays cannot live in a scrolling chat", () => {
    expect(
      chooseInlineImageRenderer(
        {
          best: Protocol.SIXEL,
          available: [Protocol.SIXEL],
          kitty: false,
          sixel: true,
          iterm2: false,
          terminal: "vscode",
        },
        { TERM_PROGRAM: "vscode" },
      ),
    ).toBe("halfblock")
  })
})

describe("toCellGrid", () => {
  test("inline image refs cannot use the whole terminal before joining the chat viewport", () => {
    expect(inlineImageViewport({ parent: null })).toBeUndefined()
    const scroll = Object.create(ScrollBoxRenderable.prototype) as ScrollBoxRenderable
    Object.defineProperty(scroll, "viewport", { value: { x: 2, y: 6, width: 70, height: 16 } })
    expect(inlineImageViewport({ parent: scroll })).toEqual({ x: 2, y: 6, columns: 70, rows: 16 })
  })
  test("ADE load retains half-block cells and prepares only OSC 1337 native output", async () => {
    const png = rgbaToPng({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) })
    const source = `data:image/png;base64,${Buffer.from(png).toString("base64")}`
    const data = await loadTuiImage(
      source,
      10,
      5,
      null,
      { width: 8, height: 16 },
      new AbortController().signal,
      { ADE_PANE_ID: "pane", ADE_MAILBOX: "mailbox" },
      jimpDecoder,
    )
    expect(data.renderer).toBe("ade")
    expect(data.overlay?.bytes).toContain("\x1b]1337;File=")
    expect(data.nativeBytes).toBeUndefined()
    expect(data.rows.length).toBeGreaterThan(0)
    expect(data.placeholder).toBeUndefined()
    expect(data.rows.length).toBe(data.overlay!.rows)
    const fallback = await loadTuiImage(
      source,
      10,
      5,
      null,
      { width: 4000, height: 4000 },
      new AbortController().signal,
      { ADE_PANE_ID: "pane", ADE_MAILBOX: "mailbox" },
      jimpDecoder,
    )
    expect(fallback.renderer).toBe("halfblock")
    expect(fallback.overlay).toBeUndefined()
    expect(fallback.rows.length).toBeGreaterThan(0)
  }, 20_000)
  test("parses half-block SGR into cells and never stores CSI", () => {
    const line = "\x1b[38;2;10;20;30m\x1b[48;2;40;50;60m▀\x1b[0m"
    const grid = toCellGrid(line, 1)
    expect(grid).toHaveLength(1)
    expect(grid[0]).toHaveLength(1)
    expect(grid[0]![0]!.char).toBe("▀")
    for (const row of grid) {
      for (const cell of row) {
        expect(cell.char).not.toContain("\x1b")
        expect(cell.char).not.toMatch(/^\d/)
      }
    }
    expect(grid[0]![0]!.fg.r).toBeCloseTo(10 / 255)
    expect(grid[0]![0]!.bg.b).toBeCloseTo(60 / 255)
  })

  test("drops cursor-addressed CSI and APC instead of painting them", () => {
    const line = "\x1b[12;40H\x1b_Ga=T,q=2;payload\x1b\\▀"
    const grid = toCellGrid(line, 1)
    expect(grid[0]!.map((cell) => cell.char).join("")).toBe("▀")
  })
})

describe("extractTuiImageUrls", () => {
  test("finds absolute Windows paths as well as Unix ones", () => {
    expect(extractTuiImageUrls("guarda C:/sbx/img/shot.png")).toEqual(["C:/sbx/img/shot.png"])
    expect(extractTuiImageUrls(String.raw`guarda C:\sbx\img\shot.png`)).toEqual([String.raw`C:\sbx\img\shot.png`])
    expect(extractTuiImageUrls(String.raw`open "D:\My Pictures\a b.jpg" now`)).toEqual([
      String.raw`D:\My Pictures\a b.jpg`,
    ])
    expect(extractTuiImageUrls("see /tmp/x.png")).toEqual(["/tmp/x.png"])
  })

  test("ignores relative paths and non-image files", () => {
    expect(extractTuiImageUrls("img/shot.png C:/notes.txt")).toEqual([])
  })
})
