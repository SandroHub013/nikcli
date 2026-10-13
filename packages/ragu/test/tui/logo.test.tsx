import { describe, expect, test } from "bun:test"
import { engine } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ThemeContext, createStandaloneTheme } from "@tui/context/theme"
import { loadBuiltInTheme } from "@tui/context/theme-catalog"
import { KVContext } from "@tui/context/kv"
import { LOGO_LINES, Logo } from "@tui/component/logo"

/*
 * The user, 2026-10-13: «quando avvio ragù cli non appare la sua scritta come
 * appariva prima nikcli nel tui». The home's wordmark is the product's name, and
 * it must be there whether or not its reveal animation ever runs.
 */

const theme = createStandaloneTheme({
  document: await loadBuiltInTheme("ragu"),
  mode: "dark",
})

async function mount(animations: boolean, compact = false) {
  const kv = {
    get: (key: string, fallback: unknown) => (key === "animations_enabled" ? animations : fallback),
  }
  return testRender(
    () => (
      <ThemeContext.Provider value={theme as never}>
        <KVContext.Provider value={kv as never}>
          <Logo idle={true} compact={compact} />
        </KVContext.Provider>
      </ThemeContext.Provider>
    ),
    { width: 60, height: 10 },
  )
}

describe("Logo", () => {
  test("with animations on, a timeline that never moves still leaves the name on screen", async () => {
    const screen = await mount(true)
    // No frame will ever tick the reveal: the case of a renderer that never goes live.
    engine.detach()
    await screen.renderOnce()
    await Bun.sleep(1400)
    await screen.renderOnce()
    const frame = screen.captureCharFrame()
    for (const line of LOGO_LINES) expect(frame).toContain(line.trimEnd())
    screen.renderer.destroy()
  })
})
