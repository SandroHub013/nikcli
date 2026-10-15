export type DialogWidthSize = "small" | "medium" | "large" | "xlarge" | "full" | undefined

/** The columns a dialog panel takes in a terminal `termWidth` wide. */
export function dialogWidth(size: DialogWidthSize, termWidth: number): number {
  // `full` is for dialogs whose *content* is the window — the browser surface,
  // where every column is a pixel of horizontal resolution and a 120-column
  // cap is a cap on how much page you can see.
  if (size === "full") return Math.max(1, termWidth - 4)
  if (size === "xlarge") return Math.min(120, Math.max(1, termWidth - 8))
  if (size === "large") return Math.min(88, Math.max(1, termWidth - 6))
  if (size === "small") return Math.min(42, Math.max(1, termWidth - 4))
  return Math.min(60, Math.max(1, termWidth - 4))
}

function cut(text: string, len: number): string {
  if (text.length <= len) return text
  return len <= 1 ? "…" : text.slice(0, len - 1) + "…"
}

/**
 * A select row's title and description share one line that the layout cuts without a trace
 * («Workspace panel (sessions · changes · graph · gi»). Cut them here instead, so a cut shows a «…»:
 * the title keeps its room, the description takes what is left, and goes if less than a word is left.
 */
export function fitOptionText(title: string, description: string | undefined, width: number): { title: string; description?: string } {
  const room = Math.max(1, width)
  const head = cut(title, Math.min(61, room))
  if (!description) return { title: head }
  const left = room - head.length - 1
  if (left < 4) return { title: head }
  return { title: head, description: cut(description, left) }
}
