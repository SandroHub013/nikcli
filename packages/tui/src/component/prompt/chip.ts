import type { RGBA } from "@opentui/core"
import { contrastFg } from "@tui/context/theme"

/**
 * The text on a coloured chip under the prompt (rec, web): black or white
 * against the chip itself. Never the page background, which can be
 * transparent: in ADE that left the chips as blocks with nothing in them.
 */
export function chipText(chip: RGBA): RGBA {
  return contrastFg(chip)
}
