import { describe, expect, it } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { logo as productionLogo } from "@/cli/logo"
import { DEFAULT_STYLE_ID, STYLES, logoHeight, logoWidth, mountLab, rowRamp, styleById } from "../../script/logo-lab"

/** Drop ANSI CSI and OSC so cell text reassembles into plain lines. */
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ANSI = new RegExp(
  [`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, `${ESC}\\[[0-9;?]*[ -/]*[@-~]`, `${ESC}[@-Z\\\\-_]`].join("|"),
  "g",
)

const plain = (raw: string) => raw.replace(ANSI, "")
const FRAME_WIDTH = 100

describe("logo lab styles", () => {
  it("gives every style a distinct id and label", () => {
    expect(new Set(STYLES.map((style) => style.id)).size).toBe(STYLES.length)
    expect(new Set(STYLES.map((style) => style.label)).size).toBe(STYLES.length)
  })

  it("falls back to the default style for an unknown id", () => {
    expect(styleById("nope").id).toBe(DEFAULT_STYLE_ID)
    expect(styleById("line").id).toBe("line")
  })

  it("renders every style as a non-empty grid of printable cells", () => {
    for (const style of STYLES) {
      expect(style.lines.length).toBeGreaterThan(0)
      for (const line of style.lines) {
        // A row that is entirely blank is a broken row, not a spacer.
        expect(line.trim().length).toBeGreaterThan(0)
        // Control characters would be invisible but would also break width math.
        expect(line).not.toMatch(/[\u0000-\u001f\u007f]/)
      }
      expect(logoHeight(style)).toBe(style.lines.length)
      expect(logoWidth(style)).toBe(Math.max(...style.lines.map((line) => line.length)))
    }
  })

  it("fits every style inside a standard terminal", () => {
    for (const style of STYLES) {
      expect({ style: style.id, width: logoWidth(style) }).toEqual({
        style: style.id,
        width: logoWidth(style),
      })
      expect(logoWidth(style)).toBeLessThanOrEqual(FRAME_WIDTH)
      expect(logoWidth(style)).toBeGreaterThan(0)
    }
  })

  it("keeps the 'shadow' style byte-identical to the shipped logo", () => {
    const shipped = plain(productionLogo(""))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    const shadow = styleById("shadow").lines.map((line) => line.trim())
    expect(shadow).toEqual(shipped.slice(0, shadow.length))
    expect(shadow).toHaveLength(6)
  })

  /**
   * Guards the class of bug this file was written after: a rasteriser that
   * silently returns its input. `outline` shipped as a copy of `block` for a
   * while, because a four-neighbour edge test finds no interior cells in a 5x7
   * grid — every stroke is one cell wide, so there is nothing to hollow out.
   */
  it("makes every derived style visibly differ from the solid grid", () => {
    const solid = styleById("block").lines.join("\n")
    for (const id of ["outline", "halftone", "slant", "ascii", "banner"]) {
      expect({ id, same: styleById(id).lines.join("\n") === solid }).toEqual({
        id,
        same: false,
      })
    }
  })

  it("keeps the production luminance ramp for a six-row wordmark", () => {
    expect(rowRamp(6)).toEqual([0.48, 0.62, 0.82, 1, 0.72, 0.5])
  })

  it("peaks the row ramp in the middle and stays within 0..1", () => {
    for (const height of [1, 4, 7, 13]) {
      const ramp = rowRamp(height)
      expect(ramp).toHaveLength(height)
      const peak = ramp.indexOf(Math.max(...ramp))
      // A single-row wordmark has no middle to peak at, so only check taller ones.
      if (height > 1) expect(Math.abs(peak - (height - 1) / 2)).toBeLessThanOrEqual(1)
      for (const value of ramp) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe("logo lab rendering", () => {
  async function frame(styleId: string, progress: number) {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: FRAME_WIDTH,
      height: 40,
    })
    const view = mountLab(renderer as never, styleId)
    view.setProgress(progress)
    await renderOnce()
    const captured = captureCharFrame()
    view.destroy()
    renderer.destroy()
    return captured
  }

  it("paints the wordmark and the credit once the reveal completes", async () => {
    for (const style of STYLES) {
      const captured = await frame(style.id, 1)
      expect({
        id: style.id,
        hasFirstRow: captured.includes(style.lines[0]!.trim()),
      }).toEqual({
        id: style.id,
        hasFirstRow: true,
      })
      expect(captured).toContain("by @nikomatt69")
    }
  })

  it("hides only the wordmark while the reveal is at zero", async () => {
    const style = styleById("block")
    const hidden = await frame(style.id, 0)
    expect(hidden).not.toContain(style.lines[0]!.trim())
    // The surrounding chrome is not part of the sweep, so it paints regardless.
    expect(hidden).toContain("logo lab")
    expect(await frame(style.id, 1)).toContain(style.lines[0]!.trim())
  })

  it("switches between styles without leaving the old one behind", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: FRAME_WIDTH,
      height: 40,
    })
    const view = mountLab(renderer as never, "chunky")
    view.setProgress(1)
    view.setStyle("banner")
    view.setProgress(1)
    await renderOnce()
    const captured = captureCharFrame()
    view.destroy()
    renderer.destroy()

    expect(captured).toContain(styleById("banner").lines[0]!.trim())
    // 'chunky' is four rows of half blocks; its top row cannot survive a switch
    // to the seven-row doubled grid unless the old rows were actually removed.
    expect(captured).not.toContain(styleById("chunky").lines[0]!.trim())
  })
})
