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
 * What opentui draws in an empty box before the first turn: «Ask anything… "Fix a TODO"». Its colour depends on the theme.
 * At 36 columns or fewer the example goes to the next row whole, and the first row ends on the dots.
 */
const BAR_PLACEHOLDER = /^[^"]*(?:\.{3}|…)(?: +"| *$)/

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
 */
export function followKeys(terminal: ComposerTerminal, agentId: string, data: string): void {
  if (!BAR_AGENTS.has(agentId)) return
  if (data === FOCUS_IN) {
    if (composerOf(terminal, agentId) === "none" && rowsOf(terminal).some((row) => MODEL_ROW.test(row))) refocused.add(terminal)
    return
  }
  const mouse = data.match(MOUSE_PRESS)
  if (data === "\x1b" || data.includes("\r") || (mouse && Number(mouse[1]) < 32)) refocused.delete(terminal)
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
  if (refocused.has(terminal)) return "none"
  // ragu gives its box the cursor back on a focus-in, with a dialog still open over it: the reading has to say so here.
  if (agentId === "ragu" && confirmDialog(rowsOf(terminal))) return "none"
  const glyph = RULED_PROMPT[agentId]
  if (!glyph) return barBox(terminal)
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
  if (!bar) return "none"
  const indent = bar[1]!.length

  // Down to the row that names the agent and the model: a question drawn in the same column has none.
  let model = cursorY
  while (model < terminal.rows && !MODEL_ROW.test(textAt(terminal, model))) {
    if (!BAR_ROW.test(textAt(terminal, model))) return "none"
    model++
  }
  if (model >= terminal.rows || model === cursorY) return "none"

  const inputColumn = indent + 3
  if (cursorX < inputColumn) return "none"
  // Its first cell, and not the whole row: a wide pane has OpenCode's sidebar further along the same rows.
  const rowHasText = (y: number) => textAt(terminal, y).charAt(inputColumn).trim() !== ""
  if (cursorX !== inputColumn) return "draft"
  for (let y = cursorY - 1; y >= 0 && BAR_ROW.test(textAt(terminal, y)); y--) if (rowHasText(y)) return "draft"
  const first = here.slice(inputColumn)
  const placeholder = BAR_PLACEHOLDER.test(first)
  if (rowHasText(cursorY) && !placeholder) return "draft"
  // A long example wraps: the rows down to its closing quote are the example too. Past that, or with no quote, a row is a line.
  const quotes = (row: string) => row.split('"').length - 1
  let below = cursorY + 1
  if (placeholder) {
    let seen = quotes(first)
    while (seen < 2 && below < model) seen += quotes(textAt(terminal, below++).slice(inputColumn))
    if (seen < 2) return "draft"
  }
  for (let y = below; y < model; y++) if (rowHasText(y)) return "draft"
  return "ready"
}
