import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { toOklch } from "@tui/context/contrast"
import { ThemeContext, createStandaloneTheme } from "@tui/context/theme"
import { loadBuiltInTheme } from "@tui/context/theme-catalog"
import { LOGO_LINES, Logo } from "@tui/component/logo"

/*
 * The user, 2026-10-13: «quando avvio ragù cli non appare la sua scritta come
 * appariva prima nikcli nel tui», and then: the home like OpenCode's, with
 * "ragucode" written in its pixel letters.
 */

const theme = createStandaloneTheme({
  document: await loadBuiltInTheme("ragu"),
  mode: "dark",
})

async function frame(compact = false) {
  const screen = await testRender(
    () => (
      <ThemeContext.Provider value={theme as never}>
        <Logo compact={compact} />
      </ThemeContext.Provider>
    ),
    { width: 60, height: 8 },
  )
  await screen.renderOnce()
  const captured = screen.captureCharFrame()
  screen.renderer.destroy()
  return captured
}

describe("Logo", () => {
  test("the home spells ragucode in pixel letters, on its first frame", async () => {
    const captured = await frame()
    for (const line of LOGO_LINES) expect(captured).toContain(line)
    // "ragu" then "code": the bowl of the a, the descender of the g, the ascender of the d.
    expect(captured).toContain("█▀▀▀ ▀▀▀█ █▀▀█ █  █ █▀▀▀ █▀▀█ █▀▀█ █▀▀█")
    expect(captured).not.toContain("███╗")
  })

  test("the short form in the session strip reads RAGU CODE", async () => {
    const captured = await frame(true)
    expect(captured).toContain("RAGUCODE")
    expect(captured).not.toContain("NIKCLI")
  })

  test("the exit summary's rows carry no marker characters", () => {
    for (const line of LOGO_LINES) expect(line).not.toMatch(/[_^~]/)
    expect(LOGO_LINES).toHaveLength(5)
  })
})

/*
 * The user, 2026-10-16 (ragu-brand, point 5): the same letters, «ragu» in tomato
 * and «code» in basil as in the logo, readable on a dark and on a light theme.
 */
describe("the wordmark's colours", () => {
  const TOMATO = RGBA.fromHex("#df4a2b")
  const BASIL = RGBA.fromHex("#4f8a2e")
  const channel = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const luminance = (c: RGBA) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
  const ratio = (a: RGBA, b: RGBA) => {
    const [x, y] = [luminance(a), luminance(b)]
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const hueApart = (a: RGBA, b: RGBA) => {
    const d = Math.abs(toOklch(a).h - toOklch(b).h) % (2 * Math.PI)
    return Math.min(d, 2 * Math.PI - d)
  }

  /** The colour of every glyph cell in `columns` of the frame: one colour, or the test fails. */
  async function colours(mode: "dark" | "light", compact: boolean) {
    const standalone = createStandaloneTheme({ document: await loadBuiltInTheme("ragu"), mode })
    const screen = await testRender(
      () => (
        <ThemeContext.Provider value={standalone as never}>
          <Logo compact={compact} />
        </ThemeContext.Provider>
      ),
      { width: 60, height: 8 },
    )
    await screen.renderOnce()
    const cells = screen
      .captureSpans()
      .lines.map((line) => line.spans.flatMap((span) => [...span.text].map((char) => ({ char, fg: span.fg }))))
    screen.renderer.destroy()
    // The full form: «ragu» in columns 0-18, a gap, «code» in 20-38. The short one: RAGU then CODE.
    const split = compact ? 4 : 20
    const width = compact ? 4 : 19
    const glyphs = (from: number) =>
      cells
        .flatMap((row) => row.slice(from, from + width).filter((cell) => cell.char.trim() !== ""))
        .map((cell) => cell.fg)
    return { base: standalone.theme.surface.base, ragu: glyphs(0), code: glyphs(split) }
  }

  for (const mode of ["dark", "light"] as const)
    for (const compact of [false, true])
      test(`«ragu» tomato and «code» basil, readable, ${mode}${compact ? ", short form" : ""}`, async () => {
        const { base, ragu, code } = await colours(mode, compact)
        expect(ragu.length).toBeGreaterThan(3)
        expect(code.length).toBeGreaterThan(3)
        for (const [cells, brand] of [
          [ragu, TOMATO],
          [code, BASIL],
        ] as const) {
          for (const fg of cells) expect(fg).toEqual(cells[0]!)
          expect(hueApart(cells[0]!, brand)).toBeLessThan(0.15)
          expect(ratio(cells[0]!, base)).toBeGreaterThanOrEqual(4.5)
        }
      })
})
