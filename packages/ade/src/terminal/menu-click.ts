/**
 * A click on a Claude Code menu, which does not ask for the mouse (mouse
 * sessions, step B).
 *
 * Claude Code draws its choices from the keyboard only: the permission
 * questions, `/model`, the pickers. A numbered list, the current entry marked
 * «❯», a hint with Esc. ADE turns a click on an entry into the keys a hand
 * would press, in two steps, and never on a guess:
 *
 * - the first click on an entry moves the highlight there, with the arrows;
 * - a second click on the same entry, once the screen has been read again and
 *   the entry is still there and now marked, sends Enter.
 *
 * No digit is typed, even where Claude would take it: one wrong click must
 * never grant a permission for good («Yes, and don't ask again»). Anything
 * that is not surely a menu, the prompt with a numbered list typed in it for
 * instance, is left alone: the click does what it did before, nothing.
 *
 * The screen is read as text, the rows of the viewport. Measured on Claude
 * Code 2.1.283 (ade-team/results/mouse-sessioni-misura.md).
 */

/** One entry of the menu: its number, its row on screen (0-based), its words. */
export interface MenuOption {
  readonly number: number
  readonly row: number
  readonly label: string
}

export interface ClaudeMenu {
  readonly options: readonly MenuOption[]
  /** The entry marked «❯». */
  readonly current: MenuOption
}

// «  ❯ 2.  Opus 5.5 ✔   Most capable», «    3.  Fable 5.1», «  ↓ 9.  Opus 4.7»
const OPTION = /^(\s*)([❯↑↓])?\s*(\d{1,2})\.\s+(\S.*)$/
// The prompt's frame and the separators: a menu is never inside or above one.
const RULE = /^\s*[─━═╌┄]{12,}/
// The hint Claude writes with a menu: «Esc to cancel», «(esc)».
const HINT = /\besc\b/i
// The menu's own hint row, «Esc to cancel», «· Esc to exit»: not a word typed in the prompt.
const ESC_TO = /(?:^\s*|·\s*)Esc to \w+/
/** At most this many rows under the menu: a menu is at the bottom of the screen. */
const TAIL_ROWS = 8
/** Continuation rows allowed between two entries (a long label wrapped). */
const GAP_ROWS = 2

/**
 * The menu on this screen, or undefined when it is not surely one: two
 * entries at least, numbered one after the other, exactly one marked «❯», the
 * numbers in one column, an Esc hint in or under it, no rule under it but
 * after that hint, and nothing but a few rows between it and the bottom of
 * the screen.
 */
export function claudeMenu(rows: readonly string[]): ClaudeMenu | undefined {
  const found: { option: MenuOption; marker: string | undefined; indent: number; column: number }[] = []
  rows.forEach((text, row) => {
    const match = OPTION.exec(text)
    if (!match) return
    const column = text.indexOf(match[3]!, match[1]!.length + (match[2] ? 1 : 0))
    found.push({
      option: { number: Number(match[3]), row, label: match[4]!.trim() },
      marker: match[2],
      indent: match[1]!.length,
      column,
    })
  })
  if (found.length < 2) return undefined

  // The last run of entries numbered one after the other, a few rows apart.
  let start = found.length - 1
  while (start > 0) {
    const previous = found[start - 1]!
    const next = found[start]!
    if (next.option.number !== previous.option.number + 1) break
    if (next.option.row - previous.option.row > GAP_ROWS + 1) break
    start--
  }
  const block = found.slice(start)
  if (block.length < 2) return undefined

  // One column for the numbers (a two-digit number may start one cell earlier).
  const column = block[0]!.column
  if (block.some((entry) => Math.abs(entry.column - column) > 1)) return undefined

  const marked = block.filter((entry) => entry.marker === "❯")
  if (marked.length !== 1) return undefined

  const first = block[0]!.option.row
  const last = block[block.length - 1]!.option.row
  const tail = rows.slice(last + 1)
  // No rule between the entries: not the prompt's frame.
  for (let row = first; row <= last; row++) if (RULE.test(rows[row] ?? "")) return undefined
  /*
   * A rule under them only after the menu's own «Esc to …»: `/export` leaves
   * the prompt's frame below it in a pane (Verifiche, mouse sessions test 2),
   * while a list typed in the prompt has its frame right under it.
   */
  const rule = tail.findIndex((text) => RULE.test(text))
  if (rule >= 0 && !tail.slice(0, rule).some((text) => ESC_TO.test(text))) return undefined
  // And the «❯» is not the prompt's, which Claude draws in the first column.
  if (rule >= 0 && marked[0]!.indent === 0) return undefined
  if (tail.filter((text) => text.trim()).length > TAIL_ROWS) return undefined
  const hinted = rows.slice(first, last + 1).some((text) => HINT.test(text)) || tail.some((text) => HINT.test(text))
  if (!hinted) return undefined

  return { options: block.map((entry) => entry.option), current: marked[0]!.option }
}

/** The entry a click on `row` is on: its own row only, not a wrapped continuation. */
export function optionAt(menu: ClaudeMenu, row: number): MenuOption | undefined {
  return menu.options.find((option) => option.row === row)
}

/** The entry the first click chose, waiting for the second. */
export interface PendingChoice {
  readonly number: number
  readonly label: string
  readonly at: number
}

/** How long a first click waits for its second. */
export const CONFIRM_MS = 10_000
/** How long the screen may still show the old highlight after the arrows. */
export const REDRAW_MS = 1_000

export type MenuStep =
  | { readonly kind: "none" }
  /** Arrows to the entry; `pending` waits for the second click. */
  | { readonly kind: "move"; readonly keys: string; readonly pending: PendingChoice }
  /** The same entry, marked: Enter. */
  | { readonly kind: "confirm"; readonly keys: string }

/**
 * What a click on `row` does, given the screen as it is now and the first
 * click still waiting, if any. `cursorKeys` is how the terminal sends an
 * arrow now (`ESC [` or, in application mode, `ESC O`).
 */
export function menuStep(
  rows: readonly string[],
  row: number,
  pending: PendingChoice | undefined,
  now: number,
  cursorKeys: "normal" | "application" = "normal",
): MenuStep {
  const menu = claudeMenu(rows)
  if (!menu) return { kind: "none" }
  const option = optionAt(menu, row)
  if (!option) return { kind: "none" }
  const waiting =
    pending && now - pending.at <= CONFIRM_MS && pending.number === option.number && pending.label === option.label
  if (waiting && menu.current.number === option.number && menu.current.label === option.label)
    return { kind: "confirm", keys: "\r" }
  // Clicked again before Claude redrew: the arrows already sent would be sent twice, past the entry.
  if (waiting && now - pending.at < REDRAW_MS) return { kind: "move", keys: "", pending }
  const from = menu.options.indexOf(menu.current)
  const to = menu.options.indexOf(option)
  const arrow = cursorKeys === "application" ? (to > from ? "\x1bOB" : "\x1bOA") : to > from ? "\x1b[B" : "\x1b[A"
  return {
    kind: "move",
    keys: arrow.repeat(Math.abs(to - from)),
    pending: { number: option.number, label: option.label, at: now },
  }
}

/** What `registerMenuClicks` needs from a terminal: little enough to fake in a test. */
export interface MenuTerminal {
  readonly rows: number
  readonly modes: { readonly mouseTrackingMode: string; readonly applicationCursorKeysMode: boolean }
  readonly buffer: {
    readonly active: {
      readonly viewportY: number
      readonly baseY: number
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined
    }
  }
  hasSelection(): boolean
}

/** The viewport's rows, as text. */
export function screenRows(terminal: MenuTerminal): string[] {
  const buffer = terminal.buffer.active
  const rows: string[] = []
  for (let y = 0; y < terminal.rows; y++) rows.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "")
  return rows
}

/**
 * Turns plain clicks on a Claude Code menu into its keys, while `enabled()`
 * says the pane is Claude Code. A click is a left press and release that did
 * not move, with no modifier, that left no selection, while the program has
 * not asked for the mouse and the view is at the bottom (a menu scrolled back
 * into view is an old one). Returns what removes it.
 */
export function registerMenuClicks(
  terminal: MenuTerminal,
  element: HTMLElement,
  options: {
    enabled: () => boolean
    send: (keys: string) => void
    now?: () => number
    /** The program asked for the mouse only for the wheel: its clicks are still ADE's. */
    wheelOnly?: () => boolean
  },
): () => void {
  const now = options.now ?? (() => Date.now())
  let pending: PendingChoice | undefined
  let press: { x: number; y: number } | undefined

  const rowOf = (event: MouseEvent) => {
    const screen = element.querySelector(".xterm-screen") ?? element
    const box = screen.getBoundingClientRect()
    if (!box.height || !terminal.rows) return undefined
    const row = Math.floor(((event.clientY - box.top) / box.height) * terminal.rows)
    return row >= 0 && row < terminal.rows ? row : undefined
  }
  const plain = (event: MouseEvent) =>
    event.button === 0 && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey

  const down = (event: Event) => {
    const mouse = event as MouseEvent
    press = plain(mouse) ? { x: mouse.clientX, y: mouse.clientY } : undefined
  }
  const up = (event: Event) => {
    const mouse = event as MouseEvent
    const start = press
    press = undefined
    if (!start || !plain(mouse)) return
    if (Math.abs(mouse.clientX - start.x) > 3 || Math.abs(mouse.clientY - start.y) > 3) return
    const row = rowOf(mouse)
    if (row === undefined) return
    // xterm settles its selection after the mouseup (xterm 6): read it on the next turn.
    setTimeout(() => {
      if (!options.enabled()) return
      if (terminal.modes.mouseTrackingMode !== "none" && !options.wheelOnly?.()) return
      if (terminal.hasSelection()) return
      const buffer = terminal.buffer.active
      if (buffer.viewportY !== buffer.baseY) return
      const cursorKeys = terminal.modes.applicationCursorKeysMode ? "application" : "normal"
      const step = menuStep(screenRows(terminal), row, pending, now(), cursorKeys)
      if (step.kind === "none") {
        pending = undefined
        return
      }
      if (step.kind === "confirm") pending = undefined
      else pending = step.pending
      if (step.keys) options.send(step.keys)
    }, 0)
  }

  element.addEventListener("mousedown", down, true)
  element.addEventListener("mouseup", up, true)
  return () => {
    element.removeEventListener("mousedown", down, true)
    element.removeEventListener("mouseup", up, true)
  }
}
