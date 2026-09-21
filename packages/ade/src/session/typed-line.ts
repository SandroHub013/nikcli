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
 * What is certain is what the user *sent*: every keystroke passes through ADE
 * on its way to the PTY (`surface/pane-renderer.tsx`), so counting it there
 * holds for every agent in the catalogue and for a plain shell alike —
 * including whichever is added next, because nothing here asks what is
 * running.
 *
 * Only the user's keystrokes come through here. ADE's own deliveries are
 * written straight to the session, so a delivery never dirties the line.
 */

/** Enter, which submits whatever was typed. */
const SUBMIT = /[\r\n]/
/** Keys that throw the line away: Ctrl+C, Ctrl+U, and Escape on its own. */
const CLEARS = new Set(["\u0003", "\u0015", "\u001b"])
const BACKSPACE = "\u0008\u007f"
/** The markers around a declared paste, which are not themselves typed. */
const PASTE_MARKERS = /\u001b\[20[01]~/g
const ESC = "\u001b"

/**
 * The count after `data` reached the session, given what was pending before.
 *
 * A chunk that begins with Escape and carries more is a key sequence — an
 * arrow, a function key, `\u001b\r` for the newline a TUI inserts without
 * submitting. It neither types nor sends: counting its letters would leave a
 * pane dirty after nothing but arrow keys, and that pane would refuse mail
 * for ever. Escape alone does clear, which is how these TUIs abandon a line.
 */
export function typedAfter(pending: number, data: string): number {
  if (data.length === 0) return pending
  if (CLEARS.has(data)) return 0

  const text = data.replace(PASTE_MARKERS, "")
  if (text.length === 0) return pending
  if (text.startsWith(ESC)) return text === `${ESC}\r` || text === `${ESC}\n` ? pending + 1 : pending
  if (SUBMIT.test(text)) return 0

  let count = pending
  for (const char of text) {
    if (BACKSPACE.includes(char)) count = Math.max(0, count - 1)
    else if (char >= " " && char !== "\u007f") count += 1
  }
  return count
}

/** Whether a delivery here would land inside something the user is writing. */
export function isTyping(pending: number | undefined): boolean {
  return (pending ?? 0) > 0
}
