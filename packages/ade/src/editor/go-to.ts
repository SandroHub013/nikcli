/** A line to go to, from a link. `at` is when it was clicked: a second click on the same link is a new goTo. */
export interface GoTo {
  line: number
  at: number
}

/**
 * Whether a file that is both picture and text shows its text: a new goTo
 * means the text, also on a pane already open on the preview.
 */
export function showTextFor(asText: boolean, target: GoTo | undefined, seen: GoTo | undefined): boolean {
  return asText || goToDue(target, seen, true)
}

/**
 * Whether to move the cursor for `target`: only for a goTo not yet carried
 * out, and only once the text it points into is there.
 *
 * Typing changes the text, and the text must not bring the cursor back to the
 * link's line: that wrote «xyz» as «zyx» at the start of the line.
 */
export function goToDue(target: GoTo | undefined, done: GoTo | undefined, ready: boolean): boolean {
  if (!target || !ready) return false
  return target.at !== done?.at || target.line !== done?.line
}
