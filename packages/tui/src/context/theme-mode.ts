import { RGBA, type TerminalColors } from "@opentui/core"
import { isDarkBackground } from "./contrast"

export type ThemeMode = "dark" | "light"

/** The mode a background colour calls for, by the WCAG luminance: white text reads better on a dark one. */
export function modeFromBackground(hex: string | null | undefined): ThemeMode | undefined {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return undefined
  return isDarkBackground(RGBA.fromHex(hex)) ? "dark" : "light"
}

/**
 * The mode `COLORFGBG` describes, as rxvt, Konsole and iTerm2 set it: `fg;bg` or `fg;default;bg`, the last field the
 * background's ANSI index. As Vim reads it: 7 (light grey) and 15 (white) are light, any other index dark.
 */
export function modeFromColorFgBg(value: string | undefined): ThemeMode | undefined {
  const bg = value?.split(";").at(-1)?.trim()
  if (!bg || !/^\d+$/.test(bg)) return undefined
  return bg === "7" || bg === "15" ? "light" : "dark"
}

/**
 * The mode to start in when the terminal did not answer the theme-mode query in time.
 *
 * It used to be dark, always: a light terminal that is slow to answer, or never does (conhost), got light text on a
 * light background. The palette query asks for the same background colour in another way, and a terminal that
 * answers neither may still say what it is in `COLORFGBG`. Dark only when nothing says otherwise.
 */
export async function fallbackThemeMode(input: {
  palette?: Promise<TerminalColors | undefined>
  colorFgBg?: string
  timeoutMs?: number
}): Promise<ThemeMode> {
  const colors = input.palette
    ? await Promise.race([
        input.palette.catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(resolve, input.timeoutMs ?? 300)),
      ])
    : undefined
  return (
    modeFromBackground(colors?.defaultBackground ?? colors?.palette[0]) ?? modeFromColorFgBg(input.colorFgBg) ?? "dark"
  )
}
