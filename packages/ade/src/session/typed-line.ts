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
/**
 * Enter is `\r`. A lone `\n` (Ctrl+J) is a new line in the box of Claude Code and the other TUIs, and `\` followed by
 * Enter is too: neither sends the draft (full review 2026-10-06, sessions 7). Read as sends, the line counted as empty,
 * the session as free, and ADE's own Enter shipped the user's half-written prompt with the mail typed after it.
 */
const SUBMIT = /\r/

export interface TypedLine {
  /** Characters typed since the line was last known empty. */
  pending: number
  /** When the last keystroke arrived, epoch ms. */
  at: number
  /** The last thing typed was a backslash: an Enter right after it is a new line, not a send. */
  backslash?: boolean
  /**
   * The last key was a lone Escape. In Claude Code one Escape closes a menu
   * or interrupts; the draft goes only on the second. Clearing on the first
   * left the count at zero with the text still there.
   */
  escape?: boolean
  /**
   * The one key typed into a menu has been taken for its answer (`typedAfter`, `menuOpen`). A second key before an Enter
   * is no answer: it is the start of what the user types next, and counts.
   */
  answered?: boolean
}

/** Whether a delivery here would land inside something the user is writing. */
export function isTyping(line: TypedLine | undefined): boolean {
  return (line?.pending ?? 0) > 0
}

/**
 * The count after `data` reached the session as the user's input.
 *
 * `menuOpen`: a menu was standing when the key arrived and, where the screen is all that says so, names that key
 * (`menuOnScreen`). The FIRST key there, on an empty line, is the menu's answer («y», «2») and goes into no input line,
 * so it is not a draft: counting it left the pane looking half-written
 * for ever after a one-key answer with no Enter, and every message to it held without limit (live test 2026-11-02,
 * F2). Only the first: xterm hands over typing one key at a time, and a menu the hook still reports while a tool runs
 * would otherwise swallow the whole instruction the user types ahead, and the mail would land in it (review B1). The
 * second key before an Enter counts, a key on top of a draft counts, and so do a paste and any sequence. Over-counting
 * is healed by the next Enter; under-counting is the damage this file exists to prevent.
 */
export function typedAfter(
  line: TypedLine | undefined,
  data: string,
  now: number,
  menuOpen = false,
): TypedLine | undefined {
  const pending = line?.pending ?? 0
  if (data.length === 0) return line

  if (data === INTERRUPT) return undefined
  if (data === ESC) return line?.escape ? undefined : { pending, at: now, escape: true }
  if (menuOpen && isOneKey(data) && !line?.pending && !line?.answered) return { pending: 0, at: now, answered: true }

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
  // The kitty keyboard protocol's Enter (SES-10): Ctrl+Enter sends, like `\r`; Shift+Enter is a newline in the draft.
  if (data === `${ESC}[13;5u`) return undefined
  if (data === `${ESC}[13;2u`) return { pending: pending + 1, at: now }
  if (data.startsWith(ESC)) {
    return data === `${ESC}\r` || data === `${ESC}\n` ? { pending: pending + 1, at: now } : keep(line, now)
  }

  /*
   * An Enter sends what was before it, not what comes after: an undeclared
   * paste of `a\rb` submits `a` and leaves `b` in the line. Counting nothing
   * there put the next delivery on top of `b`, and its Enter ran `b` with it.
   */
  if (SUBMIT.test(data)) {
    // `\` then Enter: the backslash turns into a new line in the draft, which stays as long as it was.
    if (data === "\r" && line?.backslash) return { pending, at: now }
    let rest = data.slice(data.lastIndexOf("\r") + 1)
    // The `\n` of a `\r\n` is part of the same Enter.
    if (rest.startsWith("\n")) rest = rest.slice(1)
    return rest.length === 0 ? undefined : typedAfter(undefined, rest, now)
  }

  let count = pending
  for (const char of data) {
    if (BACKSPACE.includes(char)) count = Math.max(0, count - 1)
    else if (char === "\n" || (char >= " " && char !== "\u007f")) count += 1
  }
  if (count === 0) return undefined
  return data.endsWith("\\") ? { pending: count, at: now, backslash: true } : { pending: count, at: now }
}

/** One printable character: not an Enter (which sends), not a sequence, not a paste. */
function isOneKey(data: string): boolean {
  return [...data].length === 1 && data !== "\r" && data !== "\n" && data >= " " && data !== "\u007f"
}

/**
 * Whether `data` is worth asking whether a menu stands: one printable key. Asked of everything, the screen would be read
 * for every mouse report and arrow of an any-event TUI (review B1).
 */
export function isAnswerKey(data: string): boolean {
  return isOneKey(data)
}

/**
 * A new question opened: the key that answered the last one says nothing about this one, so its first key is an answer
 * again. A real draft stays (re-review B7: two prompts in one turn, each answered with a digit and no Enter).
 */
export function questionOpened(line: TypedLine | undefined): TypedLine | undefined {
  return line?.answered ? undefined : line
}

/**
 * Whether the user has begun a line since `typedAt`, ADE's own text having gone in then: its Enter would send their half
 * line. A key that answered a menu has begun nothing: read as a line, it held back the Enter of the mail that waited on
 * that menu, and the text stayed there without it (live test of 2026-11-03, n. 7).
 */
export function typedSince(line: TypedLine | undefined, typedAt: number): boolean {
  return isTyping(line) && line!.at >= typedAt
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

/**
 * Whether `data` is an Enter that may answer a menu. Alt+Enter and a declared paste carry a `\r` and send nothing: read as
 * the answer they released a menu that still waited, and once the line was cleared the mail's Enter went into it.
 */
export function isEnterKey(data: string): boolean {
  return data.includes("\r") && !data.startsWith(ESC)
}

/**
 * Whether `data`, reaching the session as the user's input, sends a line of theirs: an Enter with something before it, in
 * the count already (`line`) or in the data itself (a paste that ends in a carriage return).
 *
 * The answer to a menu is not a line: its one key is not counted (`typedAfter`, `menuOpen`), so the Enter after it, and the
 * Enter into an empty box, send nothing the user wrote. Taken from the keys and not from the screen, because the screen
 * is behind xterm at the moment it matters, and an agent's box at rest can read as a draft (a status line in it).
 * Call it with the count as it was BEFORE `data` was added to it.
 */
export function submitsLine(line: TypedLine | undefined, data: string): boolean {
  if (!isEnterKey(data)) return false
  if (isTyping(line)) return true
  return /[^\u0000-\u001f\u007f]/.test(data.slice(0, data.indexOf("\r")))
}
