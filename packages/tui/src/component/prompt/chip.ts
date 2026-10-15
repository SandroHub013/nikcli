import type { RGBA } from "@opentui/core"
import { contrastFg, type Theme } from "@tui/context/theme"

/**
 * The text on a coloured chip under the prompt (rec, web): black or white
 * against the chip itself. Never the page background, which can be
 * transparent: in ADE that left the chips as blocks with nothing in them.
 */
export function chipText(chip: RGBA): RGBA {
  return contrastFg(chip)
}

/**
 * The rec chip's fill and text. Quiet at rest, on the prompt's own surface in the default text; red only while it
 * records or transcribes, with black or white on the red. It used to be red all the time, with «rec» in muted on the
 * red: 1.2:1 in light mode.
 */
export function voiceChip(theme: Theme, status: "idle" | "recording" | "transcribing"): { bg: RGBA; fg: RGBA } {
  if (status === "idle") return { bg: theme.surface.offset, fg: theme.foreground.default }
  return { bg: theme.status.error.fg, fg: chipText(theme.status.error.fg) }
}
