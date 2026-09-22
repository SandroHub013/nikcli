/**
 * What the user has typed into a pane and not yet sent.
 *
 * ADE delivers mail by typing it into a session's terminal, and that terminal
 * is the user's too. A delivery landing on a half-written line is pasted
 * inside the sentence and submitted with it: the agent was idle, so `isFree`
 * said yes, and the user's prompt is gone.
 *
 * The signal is not the screen. Reading the input line out of the xterm
 * buffer means parsing whatever the TUI drew, and Claude Code and agy draw a
 * box with placeholder text in it, so an empty prompt reads as a full one.
 * What is certain is what reached the PTY as the user's own input: every
 * keystroke passes through ADE on its way there (`surface/pane-renderer.tsx`),
 * and so do the two things ADE writes into the line on the user's behalf —
 * dropped file paths and dictated speech — which is why those go through the
 * same count. Nothing here asks what is running, so it holds for every agent
 * in the catalogue, for a plain shell, and for whichever is added next.
 *
 * It is the best source, not a certain one. Which keys empty the line is a
 * property of each TUI (Ctrl+K, Alt+D, vim mode, a recalled history line),
 * and the count can be wrong in both directions. Too high is healed by the
 * next Enter, or by the turn hook of a CLI that has one (`UserPromptSubmit`
 * says the line was sent, with certainty). Too low is the original damage,
 * so every rule below errs on the side of counting.
 */

/** Keys that throw the line away: Ctrl+C, and Escape pressed twice. */
const INTERRUPT = "\u0003"
const ESC = "\u001b"
const BACKSPACE = "\u0008\u007f"
/** The markers around a declared paste, which are not themselves typed. */
const PASTE_MARKERS = /\u001b\[20[01]~/g
const PASTE_START = `${ESC}[200~`
const SUBMIT = /[\r\n]/

export interface TypedLine {
  /** Characters typed since the line was last known empty. */
  pending: number
  /** When the last keystroke arrived, epoch ms. */
  at: number
  /**
   * The last key was a lone Escape. In Claude Code one Escape closes a menu
   * or interrupts; the draft goes only on the second. Clearing on the first
   * left the count at zero with the text still there.
   */
  escape?: boolean
}

/** Whether a delivery here would land inside something the user is writing. */
export function isTyping(line: TypedLine | undefined): boolean {
  return (line?.pending ?? 0) > 0
}

/** The count after `data` reached the session as the user's input. */
export function typedAfter(line: TypedLine | undefined, data: string, now: number): TypedLine | undefined {
  const pending = line?.pending ?? 0
  if (data.length === 0) return line

  if (data === INTERRUPT) return undefined
  if (data === ESC) return line?.escape ? undefined : { pending, at: now, escape: true }

  /*
   * A declared paste never submits, whatever it contains: the newline inside
   * a pasted block of code is a line in the input box, not an Enter. Reading
   * it as one left the longest drafts — the ones worth the most — unguarded.
   */
  if (data.startsWith(PASTE_START)) {
    const pasted = data.replace(PASTE_MARKERS, "")
    return pasted.length === 0 ? keep(line, now) : { pending: pending + pasted.length, at: now }
  }

  /*
   * A key sequence — an arrow, a function key, `\u001b\r` for the newline a
   * TUI inserts without submitting. It neither types nor sends: counting its
   * letters would leave a pane dirty after nothing but arrow keys. The
   * newline does count, as one more line of draft.
   */
  if (data.startsWith(ESC)) {
    return data === `${ESC}\r` || data === `${ESC}\n` ? { pending: pending + 1, at: now } : keep(line, now)
  }

  if (SUBMIT.test(data)) return undefined

  let count = pending
  for (const char of data) {
    if (BACKSPACE.includes(char)) count = Math.max(0, count - 1)
    else if (char >= " " && char !== "\u007f") count += 1
  }
  return count === 0 ? undefined : { pending: count, at: now }
}

/** The line as it was, minus a pending Escape, with the clock moved on. */
function keep(line: TypedLine | undefined, now: number): TypedLine | undefined {
  return line ? { pending: line.pending, at: now } : undefined
}

/**
 * The line after a CLI's own hook said a prompt was submitted at `submittedAt`.
 *
 * Certain where the count is not: whatever was pending before that moment
 * has been sent, so a count left too high by a key this file does not know
 * (Ctrl+K, a vim command) is put right by the next turn.
 */
export function submittedSince(line: TypedLine | undefined, submittedAt: number): TypedLine | undefined {
  return line && submittedAt >= line.at ? undefined : line
}
