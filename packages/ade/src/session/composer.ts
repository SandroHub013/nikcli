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

export type ComposerState = "ready" | "draft" | "none"

interface ComposerCell {
  getChars(): string
  isDim(): number | boolean
}

interface ComposerLine {
  translateToString(trimRight?: boolean, start?: number, end?: number): string
  getCell?(x: number): ComposerCell | undefined
}

export interface ComposerTerminal {
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
const RULED_PROMPT: Record<string, string> = { claude: "❯", agy: ">" }
/** The agents of opentui: a bar down the left of the box, its first row the text, with the agent and model below. */
const BAR_AGENTS = new Set(["ragu", "opencode"])
const BAR_ROW = /^( *)┃( |$)/
/** The bar's row that closes the box: «Build · Grok 4.7 · xAI». In a narrow pane opentui squeezes the spaces out of it. */
const MODEL_ROW = /^ *┃ {2}\S.*·/
/** What opentui draws in an empty box before the first turn: «Ask anything… "Fix a TODO"». Its colour depends on the theme. */
const BAR_PLACEHOLDER = /^[^"]*(?:\.{3}|…) +"/

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

/** Whether ADE knows this agent's input box. The others stay on the reading of menus (`questionOpen`). */
export function readsComposer(agentId: string): boolean {
  return agentId in RULED_PROMPT || BAR_AGENTS.has(agentId)
}

/** The state of the agent's box on `terminal`'s screen, or `undefined` for an agent whose box ADE does not know. */
export function composerOf(terminal: ComposerTerminal, agentId: string): ComposerState | undefined {
  if (!readsComposer(agentId)) return undefined
  if (hiddenCursor.has(terminal)) return "none"
  const glyph = RULED_PROMPT[agentId]
  return glyph ? ruledBox(terminal, glyph) : barBox(terminal)
}

const lineAt = (terminal: ComposerTerminal, y: number) =>
  terminal.buffer.active.getLine(terminal.buffer.active.baseY + y)
const textAt = (terminal: ComposerTerminal, y: number) => lineAt(terminal, y)?.translateToString(true) ?? ""

/** A row inside a box of many lines: empty, or indented under the prompt. */
const continues = (row: string) => row === "" || row.startsWith("  ")

function ruledBox(terminal: ComposerTerminal, glyph: string): ComposerState {
  const { cursorX, cursorY } = terminal.buffer.active
  // Claude Code puts a no-break space after its prompt.
  const isPrompt = (row: string) => row === glyph || row.startsWith(`${glyph} `) || row.startsWith(`${glyph} `)
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

/** Nothing after the cursor, or only dim text: Claude Code's `Try "refactor <filepath>"`. */
function afterCursorIsPlaceholder(line: ComposerLine | undefined, cursorX: number): boolean {
  const after = line?.translateToString(true, cursorX) ?? ""
  for (let i = 0; i < after.length; i++) {
    const cell = line?.getCell?.(cursorX + i)
    if (cell?.getChars().trim() && !cell.isDim()) return false
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
  return facts.composer === "ready" || (facts.armed === true && !facts.question)
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
  for (let y = cursorY + 1; y < model; y++) if (rowHasText(y)) return "draft"
  return !rowHasText(cursorY) || BAR_PLACEHOLDER.test(here.slice(inputColumn)) ? "ready" : "draft"
}
