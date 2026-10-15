import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Config } from "@/config/config"
import { ThemeContext, createStandaloneTheme } from "@tui/context/theme"
import { loadBuiltInTheme } from "@tui/context/theme-catalog"
import { SyncContext } from "@tui/context/sync"
import { KeybindProvider } from "@tui/context/keybind"
import { RouteProvider } from "@tui/context/route"
import { ToastProvider } from "@tui/ui/toast"
import { DialogProvider } from "@tui/ui/dialog"
import { CommandProvider } from "@tui/component/dialog-command"
import { TuiImageList } from "@tui/component/tui-image"
import { Keybind } from "@tui/util/keybind"

const theme = createStandaloneTheme({
  document: await loadBuiltInTheme("ragu"),
  mode: "dark",
})

const keybinds = Config.Keybinds.parse({})

// A 1×1 PNG, so the preview needs no file and no network.
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

/**
 * The key that opens an image at full resolution.
 *
 * It was ctrl+shift+o, and that key does not survive the trip to ragu: xterm 6,
 * which ADE draws with, sends nothing at all for ctrl+shift+letter, and a
 * classic terminal sends ctrl+o, which is `session_tab_back`. The key is now a
 * leader chord, which every terminal sends as two plain keys.
 */
describe("opening an image at full resolution", () => {
  test("is a leader chord no other default binding uses", () => {
    expect(keybinds.image_open).toBe("<leader>v")
    const mine = Keybind.parse(keybinds.image_open!)
    const clashes = Object.entries(keybinds)
      .filter(([name]) => name !== "image_open")
      .filter(([, value]) => Keybind.parse(value!).some((other) => mine.some((key) => Keybind.match(other, key))))
      .map(([name]) => name)
    expect(clashes).toEqual([])
  })

  test("the chord opens the chooser, and the preview names the key", async () => {
    const screen = await testRender(
      () => (
        <ThemeContext.Provider value={theme as never}>
          <SyncContext.Provider value={{ data: { config: { keybinds } } } as never}>
            <KeybindProvider>
              <ToastProvider>
                <DialogProvider>
                  <RouteProvider>
                    <CommandProvider>
                      <TuiImageList urls={[PIXEL]} maxColumns={20} maxRows={6} writer={() => {}} />
                    </CommandProvider>
                  </RouteProvider>
                </DialogProvider>
              </ToastProvider>
            </KeybindProvider>
          </SyncContext.Provider>
        </ThemeContext.Provider>
      ),
      { width: 100, height: 30 },
    )
    try {
      await screen.waitForFrame((frame) => frame.includes("ctrl+x v: open full size"))

      screen.mockInput.pressKey("x", { ctrl: true })
      await screen.flush()
      screen.mockInput.pressKey("v")
      const chooser = await screen.waitForFrame((frame) => frame.includes("Open full-resolution image"))
      expect(chooser).toContain("Open image 1: attached image")
    } finally {
      screen.renderer.destroy()
    }
  })
})
