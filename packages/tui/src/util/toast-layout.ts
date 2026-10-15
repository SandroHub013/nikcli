export type ToastVariant = "info" | "success" | "warning" | "error"

/** One glyph per variant, from the set the rest of the TUI already draws («✓» done, «✗» failed) — not «[i]» «[+]» «[x]». */
export function toastGlyph(variant: ToastVariant | undefined): string {
  switch (variant) {
    case "success":
      return "✓"
    case "warning":
      return "▲"
    case "error":
      return "✗"
    default:
      return "●"
  }
}

/** Columns the toast's text has: the panel, less its border (2), padding (4), the glyph column (3) and the gap (1). */
export function toastTextWidth(termWidth: number): number {
  return Math.max(8, Math.min(60, termWidth - 6) - 10)
}

/**
 * Rows a toast takes: its two border rows, a title row if there is one, and the message as it wraps. A one-line
 * message is a three-row toast; it used to be five (a blank row above and below), and seven with a title.
 */
export function toastHeight(message: string, title: string | undefined, textWidth: number): number {
  const width = Math.max(1, textWidth)
  const lines = message.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0)
  return 2 + (title ? 1 : 0) + lines
}

/** The row each toast starts at, stacked from `base` with `gap` rows between them. */
export function toastTops(heights: number[], base: number, gap: number): number[] {
  const tops: number[] = []
  let next = base
  for (const height of heights) {
    tops.push(next)
    next += height + gap
  }
  return tops
}
