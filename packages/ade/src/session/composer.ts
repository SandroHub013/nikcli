/**
 * The agent's own input box, read off the screen: a positive reason to type.
 *
 * Every menu ADE learned to read was followed by one it had not (live test of 2026-11-03: a trust dialog with no numbers,
 * a question wrapped at 38 columns, a first-run wizard), and each one took the text and answered with the Enter. So for an
 * agent whose input box ADE knows, the question is turned round: it types only when it sees that box, empty, with the
 * terminal's cursor in it. Anything else on the screen means wait, and no list of menus is needed.
 *
 * The cursor is what makes this hold. A program puts it where the next key lands, so a dialog over the box takes it away
 * or hides it, even where the box's rows still show behind the dialog. Rows without the cursor say nothing.
 *
 * What is begun can be read too: a line in the box is a fact, and not a count of keys (`session/typed-line.ts`).
 */

import { confirmDialog } from "./permission"

export type ComposerState = "ready" | "draft" | "none"

interface ComposerCell {
  getChars(): string
  isDim(): number | boolean
  isInverse(): number | boolean
}

interface ComposerLine {
  translateToString(trimRight?: boolean, start?: number, end?: number): string
  getCell?(x: number): ComposerCell | undefined
}

export interface ComposerTerminal {
  readonly cols: number
  readonly rows: number
  readonly buffer: {
    readonly active: {
      readonly baseY: number
      readonly cursorX: number
      readonly cursorY: number
      getLine(y: number): ComposerLine | undefined
    }
  }
}

/** A row of the box's frame: Claude Code and agy draw one above and one below it, and may label it on the right. */
const RULE = /^─{4,}/
/** The prompt glyph of a box between two rules. */
const RULED_PROMPT: Record<string, string> = { "claude-code": "❯", agy: ">" }
/**
 * Where a hidden cursor says nothing about the box. Claude Code shows its cursor only under a remote flag, or the variable
 * ADE sets (`agent_env` in `pty.rs`), which an older CLI or a second flag can ignore; without it the cursor stays hidden for
 * the whole session, and it draws its own: an inverse cell that blinks. The real one then stays wherever the last paint
 * ended, at rest as under a dialog (live test 5), so it says nothing and the box is read from its rows alone. For agy and
 * the agents of opentui the hidden cursor is the signal: their dialogs leave it over the box.
 */
const HIDES_ITS_CURSOR = new Set(["claude-code"])
/** What Claude Code may print under its box: the mode, a warning, a status line. A dialog's rows are more. */
const FOOTER_ROWS_MAX = 4
/** The agents of opentui: a bar down the left of the box, its first row the text, with the agent and model below. */
const BAR_AGENTS = new Set(["ragu", "opencode"])
const BAR_ROW = /^( *)┃( |$)/
/** The bar's row that closes the box: «Build · Grok 4.7 · xAI». In a narrow pane opentui squeezes the spaces out of it. */
const MODEL_ROW = /^ *┃ {2}\S.*·/
/**
 * The last row of opentui's home: the folder, and the version at the right. In a pane too short for the home it is painted
 * over the box, and the model's row may be under it. No question is ever asked on the home, so it closes the box as well.
 */
const HOME_FOOTER = /^ *(?:~|[A-Za-z]:|\/).*\d+\.\d+\.\d+\S* *$/
/**
 * What opentui draws in an empty box before the first turn: «Ask anything… "Fix a TODO"». Its colour depends on the theme.
 * At 36 columns or fewer the example goes to the next row whole, and the first row ends on the dots.
 */
const BAR_PLACEHOLDER = /^[^"]*(?:\.{3}|…)(?: +"| *$)/
/**
 * ragu's box from 0.2.17: no bar, the mark and the text between two rules, the mode and the model on the row under them.
 * A `!` in the mark's place is shell mode, where a line runs as a command: not a box to type into. Its plain glyphs are not
 * read: there a dialog's frame cannot be told from a table, and «Consegna ora» is the way out.
 */
const MARK_ROW = /^( *)›( |$)/
/** Whole, up to a sidebar after a gap: a dialog drawn across it leaves its own frame on the row, startup its own words. */
const MARK_RULE = /^ *─{4,}(?: {2,}.*)?$/
/** The tallest its text area grows. */
const MARK_ROWS_MAX = 6
/** The top of ragu's dialogs (`ui/dialog.tsx`): rounded, and centred on the terminal. */
const DIALOG_TOP = /╭─{8,}╮/
const FRAME_BOTTOM = /^ *╰─{8,}╯/
/**
 * The row of steps of ragu's first-run wizard, «1. …  ·  2. …  ·  3. …», with a rule under it at its own column. Before 0.2.17
 * it has no frame round it. Its wide joints and the rule are what a reply's numbered row does not have.
 */
const WIZARD_STEPS = /\b1\. \S.* {2}· {2}2\. \S.* {2}· {2}3\. \S/
const WIZARD_RULE = /^─{4,}/

/** The right margin of a box's text, more or less: a row that wrapped had no room for the next word. */
const WRAP_SLACK = 4

/** The part of a terminal that says when a program hides or shows the cursor. Off the chunk's road: only those two codes. */
interface CursorModes {
  readonly parser: {
    registerCsiHandler(
      id: { prefix?: string; final: string },
      callback: (params: (number | number[])[]) => boolean,
    ): unknown
  }
}

const hiddenCursor = new WeakSet<object>()
/** A bar agent's terminal that had a focus-in with something open over its box: see `followKeys`. */
const refocused = new WeakSet<object>()
/** A marked terminal whose next press is taken for the click that brought the focus back: see `followKeys`. */
const pressOfTheFocus = new WeakSet<object>()
/** A marked terminal that showed a dialog's hint at the focus-in: the hint's going can then be read as the dialog's. */
const hintAtFocus = new WeakSet<object>()
/**
 * How long the hint has to stay off the screen. A reading is not enough: a pane that loses rows takes the header off the top
 * until ragu repaints, with the cursor still showing, and an Enter then would pick the highlighted model.
 */
export const HINT_GONE_MS = 1_500
/** Since when no reading has found the hint, on a marked terminal. */
const hintGoneSince = new WeakMap<object, number>()
/**
 * The pane's size at the focus-in. While a pane is dragged xterm resizes at every step and ragu repaints only once it stops,
 * so the header can stay off the screen for longer than any wait, with the dialog still open: only at this size does its
 * going say anything. A pane resized since waits as before, for a key or «Consegna ora».
 */
const sizeAtFocus = new WeakMap<object, string>()
const sizeNow = (terminal: ComposerTerminal) => `${terminal.cols}x${terminal.rows}`
/**
 * What the header of a dialog of opentui's agents draws (`DialogHeader`): `esc`, or `esc/enter to close`. Only that word, at
 * the end of a field, arms the release: the `esc interrupt` under a turn and a «description» in the transcript do not. The
 * transcript shows through a dialog's blanks, so a real header can fail this, and then the mark just waits as it always has.
 */
const DIALOG_HINT_WORD = /(?:^| )esc(?: {2}|\/| *$)/
const hintWordOnScreen = (terminal: ComposerTerminal) => rowsOf(terminal).some((row) => DIALOG_HINT_WORD.test(row))
/** Once armed the dialog has gone only when the letters have, anywhere on the screen: in the transcript too they keep the wait. */
const DIALOG_HINT = "esc"
const hintOnScreen = (terminal: ComposerTerminal) => rowsOf(terminal).some((row) => row.includes(DIALOG_HINT))
const FOCUS_IN = "\x1b[I"
/** A mouse report: `ESC [ < button ; x ; y M`. A button of 32 up is a motion or the wheel, and closes nothing. */
const MOUSE_PRESS = /^\x1b\[<(\d+);\d+;\d+M$/

/**
 * Follows `terminal`'s cursor mode from its birth. xterm has it, and says it to no public API. A dialog that takes the keys
 * and has no field of its own hides the cursor, and leaves it where it was: over the box (ragu's DialogConfirm).
 */
export function watchCursor(terminal: CursorModes): void {
  const follow = (hidden: boolean) => (params: (number | number[])[]) => {
    if (params.includes(25)) {
      if (hidden) hiddenCursor.add(terminal)
      else hiddenCursor.delete(terminal)
    }
    return false
  }
  terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, follow(true))
  terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, follow(false))
}

/**
 * The keys on their way to a pane, for the one thing the screen stops saying. ragu gives its box the cursor back on every
 * focus-in, with a dialog still open over it (`refocusPrompt`), and in a wide pane the box stands beside the dialog: the
 * cursor says «box» and an Enter would be the dialog's. Each frame of opentui hides and shows the cursor, so nothing after
 * it tells them apart. The focus-in does: a box drawn and not read, at that moment, has something over it. It holds until a
 * key or a click that can close a dialog. If there was none to close, the pane waits and «Consegna ora» is the way out.
 * A click that returns to the pane sends the focus-in and then its press, and a press on the dialog's own panel leaves the
 * dialog open: the first press after a focus-in says nothing, however late it comes, since the box already has the cursor.
 * That press on the backdrop does close it, though, and no key follows: so once it has been made, a dialog whose hint was on
 * the screen at the focus-in and no longer is has gone, and the box is read again (`markStands`).
 */
export function followKeys(terminal: ComposerTerminal, agentId: string, data: string): void {
  if (!BAR_AGENTS.has(agentId)) return
  if (data === FOCUS_IN) {
    if (composerOf(terminal, agentId) === "none" && rowsOf(terminal).some((row) => MODEL_ROW.test(row) || HOME_FOOTER.test(row))) {
      refocused.add(terminal)
      pressOfTheFocus.add(terminal)
      hintGoneSince.delete(terminal)
      sizeAtFocus.set(terminal, sizeNow(terminal))
      if (hintWordOnScreen(terminal)) hintAtFocus.add(terminal)
      else hintAtFocus.delete(terminal)
    }
    return
  }
  const mouse = data.match(MOUSE_PRESS)
  const press = mouse !== null && Number(mouse[1]) < 32
  if (press && pressOfTheFocus.delete(terminal)) return
  if (data === "\x1b" || data.includes("\r") || press) refocused.delete(terminal)
}

/**
 * Whether one of ragu's dialogs is on the screen. A dialog with no field of its own, the first-run wizard for one, leaves
 * the box's cursor where it was: the cursor says nothing there, and a dialog that does not reach the box leaves it whole.
 */
export function dialogOver(terminal: ComposerTerminal, agentId: string): boolean {
  if (agentId !== "ragu") return false
  return Array.from({ length: terminal.rows }, (_, y) => y).some((y) => {
    const steps = textAt(terminal, y).match(WIZARD_STEPS)
    if (steps && WIZARD_RULE.test(textAt(terminal, y + 1).slice(steps.index))) return true
    const top = textAt(terminal, y).match(DIALOG_TOP)
    if (!top) return false
    // In cells: a wide character left of the frame takes two.
    let left = top.index!
    for (let x = 0; x < terminal.cols; x++) {
      if (lineAt(terminal, y)?.getCell?.(x)?.getChars() !== "╭") continue
      left = x
      break
    }
    if (Math.abs(terminal.cols - top[0].length - 2 * left) > 1) return false
    // Autocomplete has the same frame, stands on the box and is as wide as it: on a box the width of the pane it is centred
    // too. So may a dialog be. But ragu opens its list only on a line, and an empty box under a frame has a dialog over it.
    if (markedBox(terminal) !== "draft") return true
    let bottom = y + 1
    while (bottom < terminal.rows && !FRAME_BOTTOM.test(textAt(terminal, bottom))) bottom++
    const under = bottom + 1 < terminal.rows ? textAt(terminal, bottom + 1) : ""
    return !MARK_RULE.test(under) || under.match(/─+/)![0].length !== top[0].length
  })
}

/** The mark of a focus-in, until the press it was owed has been made and the dialog's hint has stayed off the screen. */
function markStands(terminal: ComposerTerminal): boolean {
  if (!refocused.has(terminal)) return false
  if (pressOfTheFocus.has(terminal) || !hintAtFocus.has(terminal)) return true
  if (sizeAtFocus.get(terminal) !== sizeNow(terminal) || hintOnScreen(terminal)) {
    hintGoneSince.delete(terminal)
    return true
  }
  const since = hintGoneSince.get(terminal) ?? Date.now()
  hintGoneSince.set(terminal, since)
  if (Date.now() - since < HINT_GONE_MS) return true
  refocused.delete(terminal)
  hintAtFocus.delete(terminal)
  hintGoneSince.delete(terminal)
  return false
}

/** A new process on the same terminal: what stood over the old one's box has gone with it. */
export function forgetRefocus(terminal: object): void {
  refocused.delete(terminal)
}

/** Whether ADE knows this agent's input box. The others stay on the reading of menus (`questionOpen`). */
export function readsComposer(agentId: string): boolean {
  return agentId in RULED_PROMPT || BAR_AGENTS.has(agentId)
}

/** The state of the agent's box on `terminal`'s screen, or `undefined` for an agent whose box ADE does not know. */
export function composerOf(terminal: ComposerTerminal, agentId: string): ComposerState | undefined {
  if (!readsComposer(agentId)) return undefined
  const hidden = hiddenCursor.has(terminal)
  if (hidden && !HIDES_ITS_CURSOR.has(agentId)) return "none"
  if (markStands(terminal)) return "none"
  // ragu gives its box the cursor back on a focus-in, with a dialog still open over it: the reading has to say so here.
  if (agentId === "ragu" && confirmDialog(rowsOf(terminal))) return "none"
  const glyph = RULED_PROMPT[agentId]
  if (!glyph) {
    const marked = agentId === "ragu" ? markBox(terminal) : "none"
    return marked === "none" ? barBox(terminal) : marked
  }
  return hidden ? ruledBoxFromRows(terminal, glyph) : ruledBox(terminal, glyph)
}

/**
 * Whether the cursor says a dialog is up, whatever the reading of menus makes of the screen: hidden, on every agent. It only
 * matters on a box not read as empty. A Claude Code without its cursor reads `ready` at rest from its rows, so it never asks.
 */
export function cursorSaysDialog(terminal: ComposerTerminal): boolean {
  return hiddenCursor.has(terminal)
}

const lineAt = (terminal: ComposerTerminal, y: number) =>
  terminal.buffer.active.getLine(terminal.buffer.active.baseY + y)
const textAt = (terminal: ComposerTerminal, y: number) => lineAt(terminal, y)?.translateToString(true) ?? ""
const rowsOf = (terminal: ComposerTerminal) => Array.from({ length: terminal.rows }, (_, y) => textAt(terminal, y))

/** The row the cursor is on, and where: a line at rest says the same each time, and one being written does not. */
export function composerLine(terminal: ComposerTerminal): string {
  const { cursorX, cursorY } = terminal.buffer.active
  return `${cursorX},${cursorY}:${textAt(terminal, cursorY)}`
}

/** The row the cursor is on, wherever that is: the same line after a resize moved it. */
export function composerRow(terminal: ComposerTerminal): string {
  return textAt(terminal, terminal.buffer.active.cursorY)
}

/** A row inside a box of many lines: empty, or indented under the prompt. */
const continues = (row: string) => row === "" || row.startsWith("  ")

// Claude Code puts a no-break space after its prompt.
const isPromptRow = (row: string, glyph: string) =>
  row === glyph || row.startsWith(`${glyph} `) || row.startsWith(`${glyph} `)

/**
 * The box with no cursor to go by: its last rule low on the screen, with only a footer under it, and above that the prompt
 * with a rule over it. A dialog is drawn in the box's place, so its `❯ 1. Yes` has no such frame round it.
 */
function ruledBoxFromRows(terminal: ComposerTerminal, glyph: string): ComposerState {
  let closing = terminal.rows - 1
  let footer = 0
  while (closing >= 0 && !RULE.test(textAt(terminal, closing))) {
    if (textAt(terminal, closing).trim()) footer++
    closing--
  }
  if (closing < 1 || footer > FOOTER_ROWS_MAX) return "none"
  let top = closing - 1
  while (top >= 0 && !isPromptRow(textAt(terminal, top), glyph)) {
    if (!continues(textAt(terminal, top))) return "none"
    top--
  }
  if (top < 1 || !RULE.test(textAt(terminal, top - 1))) return "none"
  for (let y = top + 1; y < closing; y++) if (textAt(terminal, y)) return "draft"
  return afterCursorIsPlaceholder(lineAt(terminal, top), 2) ? "ready" : "draft"
}

function ruledBox(terminal: ComposerTerminal, glyph: string): ComposerState {
  const { cursorX, cursorY } = terminal.buffer.active
  const isPrompt = (row: string) => isPromptRow(row, glyph)
  const here = textAt(terminal, cursorY)
  if (RULE.test(here)) return "none"

  // Up from the cursor to the prompt, or to the rule above a text too long to show its first row.
  let top = cursorY
  while (top >= 0 && !isPrompt(textAt(terminal, top)) && !RULE.test(textAt(terminal, top))) {
    if (!continues(textAt(terminal, top))) return "none"
    top--
  }
  if (top < 0) return "none"
  const scrolled = RULE.test(textAt(terminal, top))
  if (!scrolled && !RULE.test(textAt(terminal, top - 1))) return "none"

  // Down to the rule that closes the box.
  let bottom = cursorY + 1
  while (bottom < terminal.rows && !RULE.test(textAt(terminal, bottom))) {
    if (!continues(textAt(terminal, bottom))) return "none"
    bottom++
  }
  if (bottom >= terminal.rows) return "none"

  if (scrolled || cursorY !== top || cursorX !== 2) return "draft"
  for (let y = top + 1; y < bottom; y++) if (textAt(terminal, y)) return "draft"
  return afterCursorIsPlaceholder(lineAt(terminal, cursorY), cursorX) ? "ready" : "draft"
}

/**
 * Nothing after the cursor, or only dim text: Claude Code's `Try "refactor <filepath>"`. Without its native cursor it draws
 * the caret itself, an inverse first letter over the dim rest. An inverse letter alone is a letter typed, with the caret on it.
 */
function afterCursorIsPlaceholder(line: ComposerLine | undefined, cursorX: number): boolean {
  const after = line?.translateToString(true, cursorX) ?? ""
  for (let i = 0; i < after.length; i++) {
    const cell = line?.getCell?.(cursorX + i)
    if (!cell?.getChars().trim() || cell.isDim()) continue
    if (i === 0 && cell.isInverse() && after.length > 1) continue
    return false
  }
  return true
}

/** What the screen said when a line was about to go. `composer` is undefined for an agent whose box ADE does not know. */
export interface TypingFacts {
  composer: ComposerState | undefined
  /** A question reads as open: `questionOpen`, from the hook, the CLI's dialog window or the screen. */
  question: boolean
  /** The process has drawn nothing yet: what is typed now is read by whatever it opens on. */
  nothingDrawn: boolean
  /** The user pressed «Consegna ora» (`session/deliver-now.ts`). */
  armed?: boolean
}

/** Whether a line may be typed now: the first task, mail, a re-ring, a reminder, a nudge and the preamble alike. */
export function mayTypeNow(facts: TypingFacts): boolean {
  if (facts.composer === undefined) return !facts.question && !facts.nothingDrawn
  // A click is an answer to what the user sees, and a blank pane shows nothing: what it opens on would read the text.
  return facts.composer === "ready" || (facts.armed === true && !facts.question && !facts.nothingDrawn)
}

/** Whether a line has been begun in the pane: read off the box where it can be, counted from the keys where not. */
export function lineBegunNow(composer: ComposerState | undefined, counted: boolean): boolean {
  return composer === undefined ? counted : composer === "draft"
}

/** Whether a question holds the mail. An empty box with the cursor in it says none does, whatever the screen's words. */
export function questionHolds(composer: ComposerState | undefined, question: boolean): boolean {
  return composer === "ready" ? false : question
}

/** Whether an Enter must not go. Where the box can be read it goes only on a line in the box, and an empty one needs none. */
export function enterBlocked(composer: ComposerState | undefined, question: boolean): boolean {
  return composer === undefined ? question : composer !== "draft"
}

function barBox(terminal: ComposerTerminal): ComposerState {
  const { cursorX, cursorY } = terminal.buffer.active
  const here = textAt(terminal, cursorY)
  const bar = here.match(BAR_ROW)
  if (!bar) return HOME_FOOTER.test(here) ? boxPastFooter(terminal) : "none"
  const indent = bar[1]!.length

  // Down to the row that names the agent and the model: a question drawn in the same column has none.
  let model = cursorY
  while (model < terminal.rows && !MODEL_ROW.test(textAt(terminal, model)) && !HOME_FOOTER.test(textAt(terminal, model))) {
    if (!BAR_ROW.test(textAt(terminal, model))) return "none"
    model++
  }
  if (model >= terminal.rows) return boxPastFooter(terminal)
  if (model === cursorY) return "none"

  let top = cursorY
  while (top > 0 && BAR_ROW.test(textAt(terminal, top - 1))) top--
  return boxText(terminal, indent + 3, top, model)
}

/**
 * A line of many rows in a pane too short for the home. The box runs on under the footer painted over it and off the screen,
 * so the cursor can be on the footer's own row, where the text behind it cannot be read, or below it with no model's row in
 * sight. The rows above still say it: a footer with the box's bar over it and bars down to the end of the screen, and something
 * written. The home asks no questions, and nothing more is claimed than a line: an empty box here stays unread.
 */
function boxPastFooter(terminal: ComposerTerminal): ComposerState {
  const { cursorX, cursorY } = terminal.buffer.active
  let footer = cursorY
  while (footer >= 0 && BAR_ROW.test(textAt(terminal, footer))) footer--
  if (footer < 1 || !HOME_FOOTER.test(textAt(terminal, footer))) return "none"
  for (let y = cursorY + 1; y < terminal.rows; y++) if (!BAR_ROW.test(textAt(terminal, y))) return "none"
  const bar = textAt(terminal, footer - 1).match(BAR_ROW)
  if (!bar) return "none"
  const inputColumn = bar[1]!.length + 3
  if (cursorX < inputColumn) return "none"
  if (cursorX > inputColumn) return "draft"
  for (let y = footer - 1; y >= 0 && BAR_ROW.test(textAt(terminal, y)); y--) {
    if (textAt(terminal, y).charAt(inputColumn).trim()) return "draft"
  }
  return "none"
}

function markBox(terminal: ComposerTerminal): ComposerState {
  const state = markedBox(terminal)
  return state === "ready" && dialogOver(terminal, "ragu") ? "none" : state
}

/** The box as its own rows draw it, with nothing said yet about what may stand over it. */
function markedBox(terminal: ComposerTerminal): ComposerState {
  const { cursorY } = terminal.buffer.active
  let top = cursorY
  while (top >= 0 && !MARK_ROW.test(textAt(terminal, top))) {
    if (MARK_RULE.test(textAt(terminal, top))) return "none"
    top--
  }
  if (top < 1 || !MARK_RULE.test(textAt(terminal, top - 1))) return "none"
  const inputColumn = textAt(terminal, top).match(MARK_ROW)![1]!.length + 2

  let closing = cursorY + 1
  while (closing < terminal.rows && !MARK_RULE.test(textAt(terminal, closing))) {
    if (closing - top >= MARK_ROWS_MAX || textAt(terminal, closing).slice(0, inputColumn).trim()) return "none"
    closing++
  }
  // The status row under the closing rule says the box is the agent's own.
  if (closing + 1 >= terminal.rows || !textAt(terminal, closing + 1).trim()) return "none"
  return boxText(terminal, inputColumn, top, closing)
}

/** The text of a box whose rows run from `top` to `end` (not included), with the cursor in them. */
function boxText(terminal: ComposerTerminal, inputColumn: number, top: number, end: number): ComposerState {
  const { cursorX, cursorY } = terminal.buffer.active
  const here = textAt(terminal, cursorY)
  if (cursorX < inputColumn) return "none"
  // Its first cell, and not the whole row: a wide pane has OpenCode's sidebar further along the same rows.
  const rowHasText = (y: number) => textAt(terminal, y).charAt(inputColumn).trim() !== ""
  if (cursorX !== inputColumn) return "draft"
  for (let y = cursorY - 1; y >= top; y--) if (rowHasText(y)) return "draft"
  // At 30 columns the words wrap before the dots: the first row has neither them nor a quote.
  let first = here.slice(inputColumn)
  let afterFirst = cursorY + 1
  const wrapped = () => {
    const next = textAt(terminal, afterFirst).slice(inputColumn).trimStart().split(" ")[0]!
    return first.trimEnd().length + 1 + next.length >= terminal.cols - inputColumn - WRAP_SLACK
  }
  while (!BAR_PLACEHOLDER.test(first) && !first.includes('"') && afterFirst < end && rowHasText(afterFirst) && wrapped()) {
    first = `${first.trimEnd()} ${textAt(terminal, afterFirst++).slice(inputColumn)}`
  }
  const placeholder = BAR_PLACEHOLDER.test(first)
  if (rowHasText(cursorY) && !placeholder) return "draft"
  // A long example wraps: the rows down to its closing quote are the example too. Past that, or with no quote, a row is a line.
  const quotes = (row: string) => row.split('"').length - 1
  let below = afterFirst
  if (placeholder) {
    let seen = quotes(first)
    while (seen < 2 && below < end) seen += quotes(textAt(terminal, below++).slice(inputColumn))
    if (seen < 2) return "draft"
  }
  for (let y = below; y < end; y++) if (rowHasText(y)) return "draft"
  return "ready"
}
