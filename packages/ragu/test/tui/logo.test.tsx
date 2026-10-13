import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
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
