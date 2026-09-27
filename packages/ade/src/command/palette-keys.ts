/**
 * The palette's own Ctrl+N and Ctrl+P, which walk its list as in a terminal
 * or an editor: 1 for the next entry, -1 for the previous one, 0 otherwise.
 *
 * One reading for the palette and for the window's key handler, which lets
 * these two through when the palette has the focus. It took Ctrl+N as
 * `session.new` first, in capture, and the palette never saw it (review
 * area 2, MEDIO).
 */
export function paletteStep(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): 1 | -1 | 0 {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return 0
  const key = event.key.toLowerCase()
  return key === "n" ? 1 : key === "p" ? -1 : 0
}
