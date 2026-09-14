/**
 * Turning what is on the terminal into something worth sending the agent.
 *
 * The agent runs its own commands and reads their output, so that is not the
 * gap. The gap is the terminal the *user* is driving: a failing `bun test`, a
 * stack trace, a build log. Today that gets copied out by hand, and a long
 * scrollback gets copied badly.
 *
 * Two rules do the work. A selection means the user has already said which part
 * matters, so it wins outright. Otherwise the tail is what matters — the end of
 * a run is where the failure is — so the head is what gets dropped.
 */

/** Rows kept when nothing is selected. Roughly two screens of a normal terminal. */
export const DEFAULT_MAX_LINES = 60

export type TerminalExcerpt = {
  text: string
  /** Lines dropped from the top, so the caller can say so rather than hide it. */
  dropped: number
  source: "selection" | "scrollback"
}

export function terminalExcerpt(input: {
  selection: string
  scrollback: string
  maxLines?: number
}): TerminalExcerpt | undefined {
  const maxLines = input.maxLines ?? DEFAULT_MAX_LINES

  const selection = input.selection.replace(/\s+$/, "")
  if (selection.trim()) {
    // A selection is an explicit choice; truncating it would second-guess it.
    return { text: selection, dropped: 0, source: "selection" }
  }

  const lines = input.scrollback.split("\n")
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop()
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift()
  if (lines.length === 0) return undefined

  const kept = lines.slice(-maxLines)
  return { text: kept.join("\n"), dropped: lines.length - kept.length, source: "scrollback" }
}

/**
 * The block that goes into the prompt.
 *
 * Fenced so the agent reads it as output rather than as instructions, and
 * labelled with what was dropped: silently sending a truncated log is how an
 * agent ends up confidently explaining the wrong error.
 */
export function formatTerminalExcerpt(input: { excerpt: TerminalExcerpt; title: string }): string {
  const trimmed =
    input.excerpt.dropped > 0
      ? `
[${input.excerpt.dropped} earlier line${input.excerpt.dropped === 1 ? "" : "s"} not shown]`
      : ""
  const fence = fenceFor(input.excerpt.text)
  return `[${input.title}]${trimmed}
${fence}
${input.excerpt.text}
${fence}
`
}

/**
 * A fence the content cannot close.
 *
 * Terminal output prints backticks — a failing test echoing a markdown snippet,
 * a shell error quoting a command. A three-backtick fence would end there, and
 * the rest of the log would arrive as prose for the agent to act on. CommonMark
 * closes a fence only on a run at least as long as the opener, so the opener is
 * made longer than anything inside.
 */
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return "`".repeat(Math.max(3, longest + 1))
}
