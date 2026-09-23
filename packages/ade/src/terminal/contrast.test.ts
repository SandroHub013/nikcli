import { describe, expect, it } from "bun:test"
import type { ITheme } from "@xterm/xterm"
import { contrastFor, paintTerminals } from "./registry"

describe("contrastFor (audit 0.7.7, Architect)", () => {
  it("asks xterm for 4.5:1 in light and dark, not in glass", () => {
    expect(contrastFor("light")).toBe(4.5)
    // Claude's prompt measured 1.92:1 in dark, drawn for the light theme it started in.
    expect(contrastFor("dark")).toBe(4.5)
    // The glass background is transparent: xterm would measure against a colour that is not on screen.
    expect(contrastFor("glass")).toBe(1)
    expect(contrastFor(undefined)).toBe(1)
  })
})

describe("paintTerminals", () => {
  const fake = () => ({ terminal: { options: {} as { theme?: ITheme; allowTransparency?: boolean; minimumContrastRatio?: number } } })

  it("a theme change reaches every terminal already open", () => {
    const registry = [fake(), fake()]
    const light: ITheme = { background: "rgb(250, 250, 250)", foreground: "rgb(20, 20, 20)" }
    paintTerminals(registry, light, "light")
    for (const session of registry) {
      expect(session.terminal.options.minimumContrastRatio).toBe(4.5)
      expect(session.terminal.options.theme).toBe(light)
    }

    const glass: ITheme = { background: "rgba(0, 0, 0, 0)", foreground: "rgb(230, 230, 230)" }
    paintTerminals(registry, glass, "glass")
    for (const session of registry) {
      expect(session.terminal.options.minimumContrastRatio).toBe(1)
      expect(session.terminal.options.allowTransparency).toBe(true)
    }

    paintTerminals(registry, { background: "rgb(16, 16, 16)" }, "dark")
    for (const session of registry) expect(session.terminal.options.minimumContrastRatio).toBe(4.5)
  })
})
