import { describe, expect, test } from "bun:test"
import type { TerminalColors } from "@opentui/core"
import { fallbackThemeMode, modeFromBackground, modeFromColorFgBg } from "@tui/context/theme-mode"
import { tuiSource } from "./tui-source"

/**
 * P0 #5 of the triple-A review: a terminal that does not answer the theme-mode query within a second started the TUI
 * dark, light text on its light background, and a single manual toggle then outvoted every later detection.
 */

const colors = (defaultBackground: string) => ({ defaultBackground, palette: [] }) as unknown as TerminalColors

describe("the mode when the terminal does not answer", () => {
  test("a background colour says dark or light by its luminance", () => {
    expect(modeFromBackground("#0c0c0c")).toBe("dark")
    expect(modeFromBackground("#fafafa")).toBe("light")
    expect(modeFromBackground("#f4e7cd")).toBe("light")
    expect(modeFromBackground("#3a3a3a")).toBe("dark")
    expect(modeFromBackground(undefined)).toBeUndefined()
    expect(modeFromBackground("#abc")).toBeUndefined()
  })

  test("COLORFGBG says it by the background's ANSI index", () => {
    expect(modeFromColorFgBg("15;0")).toBe("dark")
    expect(modeFromColorFgBg("0;15")).toBe("light")
    expect(modeFromColorFgBg("0;default;7")).toBe("light")
    expect(modeFromColorFgBg("default;default")).toBeUndefined()
    expect(modeFromColorFgBg(undefined)).toBeUndefined()
  })

  test("the palette's background first, then COLORFGBG, and dark only when nothing says otherwise", async () => {
    const never = new Promise<TerminalColors | undefined>(() => {})
    expect(await fallbackThemeMode({ palette: Promise.resolve(colors("#ffffff")), colorFgBg: "15;0" })).toBe("light")
    expect(await fallbackThemeMode({ palette: Promise.resolve(undefined), colorFgBg: "0;15" })).toBe("light")
    expect(await fallbackThemeMode({ palette: never, colorFgBg: "0;15", timeoutMs: 20 })).toBe("light")
    expect(await fallbackThemeMode({ palette: Promise.reject(new Error("no tty")), timeoutMs: 20 })).toBe("dark")
    expect(await fallbackThemeMode({})).toBe("dark")
  })
})

describe("where the mode is decided", () => {
  test("startup falls back on the terminal's colours, not on a fixed dark", async () => {
    const app = await tuiSource("app.tsx")
    expect(app).not.toMatch(/waitForThemeMode\?\.\(\d+\)\)\s*\?\?\s*"dark"/)
    expect(app).toContain("fallbackThemeMode(")
  })

  test("a later answer from the terminal still applies, unless the user chose a mode", async () => {
    const theme = await tuiSource("context/theme.tsx")
    expect(theme).toContain("CliRenderEvents.THEME_MODE")
    expect(theme).toContain("followTerminal")
  })
})
