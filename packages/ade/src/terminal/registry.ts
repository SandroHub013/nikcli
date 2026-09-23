/**
 * One terminal per session, kept outside the view.
 *
 * A pane is not a stable place to keep a terminal: it is collapsed, expanded,
 * moved between columns and — until the pointer-down remount was fixed — thrown
 * away and rebuilt. The scrollback has to survive all of that, and output keeps
 * arriving while a pane is not on screen at all, so the emulator lives here and
 * the pane only borrows it.
 *
 * Nothing in this module knows about the pty. It receives text and hands back
 * keystrokes; whoever owns the process wires the two together.
 */
import { FitAddon } from "@xterm/addon-fit"
import { Terminal, type ITheme } from "@xterm/xterm"
import { registerLinks, type LinkRequest } from "./links"
import { selectionReachesSecret, watchRows, type CoverBuffer } from "./recording-cover"

export interface SessionTerminal {
  terminal: Terminal
  fit: FitAddon
  /** Where it is currently drawn, if anywhere. */
  element?: HTMLElement
  detach?: () => void
  /** Stops the take's row reader, while one runs. See `coverTerminals`. */
  uncover?: () => void
  /** The pane that draws it says a copy was refused during a take. */
  copyBlocked?: () => void
  /** The last size that held still in its cell and was handed to `onResize` (S77). */
  settled?: { cols: number; rows: number }
}

const terminals = new Map<string, SessionTerminal>()

/*
 * The palette is read from ADE's own tokens rather than hardcoded, so a session
 * looks like it belongs to the window it is in. xterm needs concrete colours —
 * it cannot take a var() — so they are resolved at creation and again whenever
 * a terminal is attached to a pane.
 *
 * Resolved, not read. A custom property computes to the text it was declared
 * with, so `getPropertyValue("--ade-surface")` hands back
 * `light-dark(#faf9f8, #1a1818)`; xterm cannot parse that and quietly falls back
 * to its own white on black. Setting the token as a probe's `color` and reading
 * the computed value makes the browser pick the half for the scheme in effect.
 */
const ANSI_SLOTS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const

type ColourSlot = Exclude<keyof ITheme, "extendedAnsi">

/**
 * Read from ADE's own root, which is where every token now lives.
 *
 * This used to take a `scope`, because the ANSI palette was declared inside
 * `[data-component="session-pane"]` — and both call sites passed nothing, so
 * the sixteen colours were never found and xterm kept its own defaults. The
 * palette moved to `:root` (see index.css) precisely so that there is one
 * place to read it from and no way to read it from the wrong one.
 *
 * The probe stays in the ADE shell rather than on `document.body`: `light-dark()`
 * resolves against the computed `color-scheme`, and the theme attribute is
 * stamped on ADE's own root, not on the document. Reading from outside the
 * shell would always return the dark half.
 */
function readTheme(): ITheme {
  if (typeof document === "undefined" || !document.body) return {}
  const host =
    document.querySelector('[data-component="ade-shell"]') ?? document.body
  const declared = getComputedStyle(host)
  const probe = document.createElement("span")
  probe.setAttribute("aria-hidden", "true")
  // Visible to the cascade, invisible to the user: `light-dark()` is resolved
  // from computed style, and an element kept in the box tree cannot be
  // short-circuited by an engine that skips work for `display: none`.
  probe.style.cssText =
    "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none"
  host.appendChild(probe)

  const theme: ITheme = { selectionBackground: "rgba(10, 124, 107, 0.25)" }
  // The first token declared in scope wins. A slot with none keeps xterm's
  // default, where an undeclared var() would hand the probe the text colour.
  const slot = (key: ColourSlot, ...tokens: string[]) => {
    const token = tokens.find((name) => declared.getPropertyValue(name).trim().length > 0)
    if (!token) return
    probe.style.color = `var(${token})`
    theme[key] = getComputedStyle(probe).color
  }
  slot("background", "--ade-terminal-bg", "--ade-sunken")
  slot("foreground", "--ade-terminal-fg", "--ade-text")
  slot("cursor", "--ade-accent")
  slot("selectionBackground", "--ade-selection")
  for (const name of ANSI_SLOTS) slot(name, `--ade-ansi-${name}`)

  probe.remove()
  return theme
}

/**
 * Repaints every live terminal in the theme now in effect.
 *
 * Terminals outlive the panes that draw them, and the panes are memoised so
 * that pressing one does not rebuild its DOM — which together mean nothing
 * remounts when the theme changes, and `attachTerminal` is the only place that
 * ever re-read the colours. Toggling the theme recoloured the whole window
 * except the part of it the user is actually reading, until the launch screen
 * happened to unmount the grid.
 */
/**
 * Whether the resolved background lets what is behind it through.
 *
 * In the glass theme the background token is `transparent`, and xterm draws
 * an opaque cell layer unless it is told otherwise — a terminal painted black
 * over a window the user asked to see through.
 */
function isTranslucent(theme: ITheme): boolean {
  const background = theme.background
  if (!background) return false
  const alpha = /rgba?\([^)]*,\s*([\d.]+)\s*\)/.exec(background)
  return alpha ? Number(alpha[1]) < 1 : false
}

/**
 * The contrast xterm enforces between a cell's text and its background.
 *
 * 4.5 in the light theme and in the dark one. Claude Code draws in the
 * truecolour of the theme it started in, not ADE's: on ADE's light background
 * its text measured 1.83:1 («❯ No, exit»), and in dark its prompt measured
 * 1.92:1 in auto mode after starting while ADE was light. ADE had never set
 * the option (audit 0.7.7, Architect). xterm only changes colours below the
 * threshold, so the ones already readable stay as they are.
 *
 * Glass keeps 1: its background is transparent, and xterm would compute the
 * contrast against the background colour it was given, not the window seen
 * through it — the correction would be a guess, and could make text worse.
 * An unknown theme keeps 1 too: nothing to measure against.
 */
export function contrastFor(theme: string | undefined): number {
  return theme === "light" || theme === "dark" ? 4.5 : 1
}

/** The theme ADE's shell is drawn in now, as `data-theme` on it says. */
function currentThemeName(): string | undefined {
  if (typeof document === "undefined") return undefined
  return document.querySelector('[data-component="ade-shell"]')?.getAttribute("data-theme") ?? undefined
}

/** What a repaint touches of a terminal: its options, nothing else. */
interface Paintable {
  terminal: { options: { theme?: ITheme; allowTransparency?: boolean; minimumContrastRatio?: number } }
}

/**
 * Paints each terminal in `palette` for the theme named `themeName`: the
 * colours, the transparency and the contrast, always together, so a terminal
 * already open follows a theme change the same way a new one starts in it.
 */
export function paintTerminals(sessions: Iterable<Paintable>, palette: ITheme, themeName: string | undefined): void {
  for (const session of sessions) {
    session.terminal.options.theme = palette
    session.terminal.options.allowTransparency = isTranslucent(palette)
    session.terminal.options.minimumContrastRatio = contrastFor(themeName)
  }
}

export function refreshTerminalThemes(): void {
  if (terminals.size === 0) return
  paintTerminals(terminals.values(), readTheme(), currentThemeName())
}

/**
 * Copies text to the system clipboard.
 * Uses navigator.clipboard when available, falling back to a hidden textarea execCommand.
 *
 * Writing only. Never `navigator.clipboard.readText`: in WebView2 it opens a
 * permission dialog that blocks the page until someone answers it, and ADE Test
 * can only be restarted to get out of it.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* fallback below */
    }
  }

  if (typeof document !== "undefined" && document.body) {
    try {
      const active = document.activeElement as HTMLElement | null
      const textarea = document.createElement("textarea")
      textarea.value = text
      textarea.setAttribute("readonly", "")
      textarea.style.position = "fixed"
      textarea.style.left = "-9999px"
      textarea.style.top = "-9999px"
      textarea.style.opacity = "0"
      document.body.appendChild(textarea)
      textarea.select()
      const success = document.execCommand("copy")
      textarea.remove()
      active?.focus?.()
      return success
    } catch {
      return false
    }
  }
  return false
}

/**
 * Identifies if a keyboard event is a Copy shortcut (Ctrl+C, Cmd+C, or Ctrl+Shift+C).
 */
export function isCopyShortcut(event: KeyboardEvent): boolean {
  const isMod = event.ctrlKey || event.metaKey
  if (!isMod) return false
  const key = event.key?.toLowerCase()
  return key === "c" || event.code === "KeyC"
}

/**
 * The left button is ADE's: it selects, even when the program has asked for the mouse.
 *
 * xterm consults this only while the program has mouse reporting on, so a shell
 * or Codex keeps Alt+drag as today's column selection.
 *
 * The trade-off: a program that uses the left click, a clickable menu for
 * instance, gets it only with Alt held. Claude Code and Codex are driven from
 * the keyboard, and a plain drag in Claude Code was measured to do nothing at
 * all. The wheel and the right and middle buttons stay the program's, because
 * in the alternate buffer scrolling is the program's to do, not xterm's.
 */
export function configureTerminalSelection(terminal: Terminal): void {
  const core = (terminal as any)._core
  const sel = core?._selectionService
  if (sel && typeof sel.shouldForceSelection === "function") {
    sel.shouldForceSelection = (event: MouseEvent) => (event.button === 0 || event.button === undefined) && !event.altKey
  }
}

/**
 * What a selection copies as text.
 *
 * In the normal buffer xterm's own text is right: it already joins the lines
 * the pane wrapped. In the alternate buffer every line is put there by the
 * program, which marks most of them as wrapped; joining those turned four
 * copied lines into one, padded with spaces. So there it is one line per
 * screen row, with the padding cut.
 */
export function selectionText(terminal: Terminal): string {
  const buffer = terminal.buffer.active
  let text: string
  if (buffer.type === "alternate") {
    // Zero-based cells, end exclusive: xterm's typings say otherwise, its code does this.
    const range = terminal.getSelectionPosition()
    if (!range) return ""
    const rows: string[] = []
    for (let y = range.start.y; y <= range.end.y; y++) {
      const start = y === range.start.y ? range.start.x : 0
      const end = y === range.end.y ? range.end.x : terminal.cols
      rows.push((buffer.getLine(y)?.translateToString(true, start, end) ?? "").trimEnd())
    }
    text = rows.join("\n")
  } else {
    text = terminal.getSelection()
  }
  return text.replace(/(?:\r?\n[^\S\r\n]*)+$/, "")
}

/** What `copyOnRelease` needs from a terminal: little enough to fake in a test. */
export type CopySource = Pick<Terminal, "hasSelection" | "onSelectionChange">

/**
 * Copies a selection the moment the button that made it comes up.
 *
 * Only a selection that changed during this press: a click that selects
 * nothing new must not copy an old selection again. The release is listened
 * for on `release` (the document), because a drag often ends outside the pane.
 *
 * The decision waits a turn after the release. xterm reports the selection's
 * last change only after the mouseup has gone through both phases, so a
 * decision taken in the handler saw no change and never copied. xterm itself
 * finishes a selection in a `setTimeout` 0, and so does this.
 */
export function copyOnRelease(
  terminal: CopySource,
  element: EventTarget,
  release: EventTarget,
  copy: () => void,
): () => void {
  let pressed = false
  let changed = false
  let decision: ReturnType<typeof setTimeout> | undefined
  const down = (event: Event) => {
    if ((event as MouseEvent).button !== 0) return
    if (decision) clearTimeout(decision)
    decision = undefined
    pressed = true
    changed = false
  }
  const up = (event: Event) => {
    if (!pressed || (event as MouseEvent).button !== 0) return
    // Still pressed until the decision: the change xterm reports after the
    // release belongs to this press.
    decision = setTimeout(() => {
      decision = undefined
      pressed = false
      if (changed && terminal.hasSelection()) copy()
    }, 0)
  }
  const selection = terminal.onSelectionChange(() => {
    if (pressed) changed = true
  })
  element.addEventListener("mousedown", down, true)
  release.addEventListener("mouseup", up, true)
  return () => {
    if (decision) clearTimeout(decision)
    selection.dispose()
    element.removeEventListener("mousedown", down, true)
    release.removeEventListener("mouseup", up, true)
  }
}

/**
 * Key event handler for terminal emulator:
 * - Allows voice shortcuts (Mod+Shift+J/K) to bypass xterm and reach window
 * - When text is selected, intercepts Ctrl+C / Cmd+C / Ctrl+Shift+C to copy without SIGINT and clears selection
 * - When no text is selected (or after selection is cleared), allows Ctrl+C to send SIGINT (\x03)
 */
export function createTerminalKeyHandler(terminal: Terminal, onCopyBlocked?: () => void): (event: KeyboardEvent) => boolean {
  return (event: KeyboardEvent) => {
    const isMod = event.ctrlKey || event.metaKey
    if (isMod && event.shiftKey) {
      const k = event.key?.toLowerCase()
      if (k === "j" || k === "k" || event.code === "KeyJ" || event.code === "KeyK") {
        return false
      }
    }

    if (isCopyShortcut(event)) {
      if (terminal.hasSelection()) {
        if (event.type === "keydown") {
          if (copyIsCovered(terminal)) onCopyBlocked?.()
          else void copyToClipboard(selectionText(terminal))
          terminal.clearSelection()
        }
        return false
      }
      return true
    }

    return true
  }
}

export function getTerminal(id: string): SessionTerminal {
  const existing = terminals.get(id)
  if (existing) return existing

  const initialTheme = readTheme()
  const terminal = new Terminal({
    /*
     * Scrollback is what makes a session reviewable after the fact. Agents are
     * verbose — a single tool call can be hundreds of lines — and the default
     * thousand would quietly eat the beginning of most runs. Five thousand keeps
     * a long run reviewable at half the memory of the ten thousand it was: the
     * buffer is held for every terminal, hidden panes included, and a full one
     * at wide columns ran to tens of megabytes each.
     */
    scrollback: 5_000,
    fontSize: 12,
    fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, ui-monospace, monospace",
    lineHeight: 1.25,
    // A visible block that stops blinking when the pane loses focus: with six
    // sessions tiled, a blinking cursor in each is a room full of distractions.
    cursorBlink: false,
    cursorStyle: "block",
    allowProposedApi: true,
    convertEol: false,
    theme: initialTheme,
    allowTransparency: isTranslucent(initialTheme),
    minimumContrastRatio: contrastFor(currentThemeName()),
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: true,
  })

  const fit = new FitAddon()
  terminal.loadAddon(fit)

  const created: SessionTerminal = { terminal, fit }
  terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, () => created.copyBlocked?.()))

  terminals.set(id, created)
  return created
}

export function hasTerminal(id: string): boolean {
  return terminals.has(id)
}

export function writeToTerminal(id: string, chunk: string): void {
  getTerminal(id).terminal.write(chunk)
}

/**
 * What moves a written screen into the scrollback and puts the cursor home.
 *
 * A process started in a pane begins at 1;1: that is what `pty.rs` tells
 * ConPTY, which asks before it lets the child speak. A pane reused by a
 * restart still shows the last run with the cursor somewhere below it, and the
 * new shell drew over it from the top. One newline per row, from wherever the
 * cursor is, scrolls every visible line out; nothing is erased.
 */
export function cleanScreenSequence(rows: number, written: boolean): string {
  return written ? "\r\n".repeat(Math.max(1, rows)) + "[H" : ""
}

/** Gives the next process in `id` an empty screen at 1;1, the old one kept in the scrollback. */
export function startOnCleanScreen(id: string): void {
  const session = terminals.get(id)
  if (!session) return
  const { terminal } = session
  const buffer = terminal.buffer.active
  const written = buffer.baseY > 0 || buffer.cursorY > 0 || buffer.cursorX > 0
  const sequence = cleanScreenSequence(terminal.rows, written)
  if (sequence) terminal.write(sequence)
}

/** Prints a line of ADE's own, marked so it cannot be mistaken for the agent. */
export function noteInTerminal(id: string, text: string): void {
  getTerminal(id).terminal.writeln(`\u001b[2m${text}\u001b[0m`)
}

export interface AttachOptions {
  /** Keystrokes the user typed, to be forwarded to the process. */
  onInput?: (data: string) => void
  /** The terminal's new size after a fit, in character cells. */
  onResize?: (cols: number, rows: number) => void
  /** A selection was copied on release; the pane says so for a moment. */
  onCopied?: () => void
  /** A copy was refused because the selection reaches a line blurred in a take (D68). */
  onCopyBlocked?: () => void
  /** Whether the program has mouse reporting on, whenever that changes. */
  onMouseMode?: (reporting: boolean) => void
  /** A URL or a file path in the output was clicked. See `links.ts`. */
  onLink?: (request: LinkRequest) => void
}

/**
 * The size a process in `id` should have, or undefined if the pane cannot say.
 *
 * A process started before its pane was fitted was born at the host's 120×30,
 * and the fit that came while `host.spawn` was awaited found no session to
 * resize: the pty stayed at 120 columns in a cell of 80 (S77). With this the
 * process is born at the pane's size, and resized to it once registered.
 *
 * Only a terminal drawn in a cell, and only a size that has held still there
 * (`settled`): a size read mid-layout is the one-column screen of the next note.
 */
export function ptySize(id: string): { cols: number; rows: number } | undefined {
  const session = terminals.get(id)
  return session ? ptySizeOf(session) : undefined
}

export function ptySizeOf(session: Pick<SessionTerminal, "element" | "settled">): { cols: number; rows: number } | undefined {
  const size = session.settled
  if (!session.element || !size || size.cols < 2 || size.rows < 1) return undefined
  return { cols: size.cols, rows: size.rows }
}

/**
 * How long a fitted size must hold before the process is told (S77).
 *
 * A cell passes through sizes that are not its own while the grid lays out:
 * restored panes all mount at once, and a pane can measure a few dozen pixels
 * wide for a frame. Every fit used to go straight to the pty, and a program that
 * prints once and never reflows, like Claude Code replaying a `--resume`, wrote
 * its history at that width: one word per line, «sked / or / that». The
 * terminal still fits at once; only the process waits for the size to settle.
 */
export const SETTLE_MS = 80

/** Calls `send` with the last size pushed, once none has come for `wait` ms, and never twice with the same one. */
export function createSizeSettler(
  send: (cols: number, rows: number) => void,
  wait = SETTLE_MS,
): { push: (cols: number, rows: number) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let sent: string | undefined
  return {
    push(cols, rows) {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        if (sent === `${cols}x${rows}`) return
        sent = `${cols}x${rows}`
        send(cols, rows)
      }, wait)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

/**
 * How to get an emulator into the pane that is asking for it.
 *
 * `open()` builds xterm's DOM the first time and does nothing at all on any
 * later call — it returns early as soon as the terminal has an element, without
 * so much as looking at the parent it was handed. So only a terminal that has
 * never been drawn can be opened; one that has already been drawn has to be
 * moved by hand, or it stays inside the pane it was first drawn in and every
 * pane rebuilt after that comes back empty.
 *
 * Rebuilding is the common case, not the rare one: opening the launch screen
 * unmounts the whole grid, so every running session's pane is thrown away and
 * remade the moment another session starts.
 */
export function placementFor(drawn: { parentElement: unknown } | null | undefined, parent: unknown): "open" | "move" | "keep" {
  if (!drawn) return "open"
  return drawn.parentElement === parent ? "keep" : "move"
}

/**
 * Draws the terminal into `element` and keeps it fitted to it.
 *
 * Returns a detach function rather than disposing: the session is still running
 * and its scrollback still matters, so leaving a pane must cost nothing more
 * than the DOM it was drawn in.
 */
export function attachTerminal(id: string, element: HTMLElement, options: AttachOptions = {}): () => void {
  const session = getTerminal(id)
  session.detach?.()

  paintTerminals([session], readTheme(), currentThemeName())

  const drawn = session.terminal.element
  const placement = placementFor(drawn, element)
  if (placement === "open") {
    session.terminal.open(element)
  } else if (placement === "move" && drawn) {
    element.appendChild(drawn)
    // The rows travel with the element, but they were painted for a parent
    // that no longer holds them; without this the pane can come back blank
    // until the next byte arrives.
    try {
      session.terminal.refresh(0, session.terminal.rows - 1)
    } catch {
      /* a terminal with no rows yet has nothing to repaint */
    }
  }
  session.element = element
  configureTerminalSelection(session.terminal)

  const inputHandler = options.onInput ? session.terminal.onData(options.onInput) : undefined

  const terminal = session.terminal
  const stopCopy =
    typeof document === "undefined"
      ? undefined
      : copyOnRelease(terminal, element, document, () => {
          if (copyIsCovered(terminal)) return options.onCopyBlocked?.()
          void copyToClipboard(selectionText(terminal)).then((copied) => {
            if (copied) options.onCopied?.()
          })
        })

  const stopLinks = options.onLink ? registerLinks(terminal, element, options.onLink) : undefined

  session.copyBlocked = options.onCopyBlocked

  // A pane drawn or moved during a take is born covered, with a reader of its own.
  if (covering) cover(session)

  // xterm has no event for a mode change, so the mode is read after parsed
  // output, at most every 500 ms.
  let reporting: boolean | undefined
  let modeTimer: ReturnType<typeof setTimeout> | undefined
  const readMode = () => {
    modeTimer = undefined
    const now = terminal.modes.mouseTrackingMode !== "none"
    if (now === reporting) return
    reporting = now
    options.onMouseMode?.(now)
  }
  readMode()
  const modeWatch = options.onMouseMode
    ? terminal.onWriteParsed(() => {
        if (!modeTimer) modeTimer = setTimeout(readMode, 500)
      })
    : undefined

  // The process hears only a size that has held still: see `SETTLE_MS`.
  const settler = createSizeSettler((cols, rows) => {
    session.settled = { cols, rows }
    options.onResize?.(cols, rows)
  })

  const applyFit = () => {
    // A pane can be zero-sized for a frame — collapsed, or mid-layout — and
    // fitting against that throws inside xterm's renderer.
    if (element.clientWidth < 2 || element.clientHeight < 2) return
    try {
      session.fit.fit()
    } catch {
      return
    }
    settler.push(session.terminal.cols, session.terminal.rows)
  }

  const observer = new ResizeObserver(() => applyFit())
  observer.observe(element)
  applyFit()

  const detach = () => {
    observer.disconnect()
    settler.cancel()
    inputHandler?.dispose()
    stopCopy?.()
    stopLinks?.()
    modeWatch?.dispose()
    if (modeTimer) clearTimeout(modeTimer)
    session.uncover?.()
    session.uncover = undefined
    session.copyBlocked = undefined
    session.element = undefined
    session.detach = undefined
  }
  session.detach = detach
  return detach
}

/*
 * The take (D68). While one runs, every row of every terminal is blurred by
 * the CSS in `index.css`, and a reader per terminal (`recording-cover.ts`)
 * shows the rows it judges clean. A terminal with no rows drawn has nothing to
 * read and stays blurred as a whole.
 */
let covering = false

function cover(session: SessionTerminal): void {
  session.uncover?.()
  session.uncover = undefined
  const rows = session.terminal.element?.querySelector(".xterm-rows")
  if (!rows || typeof MutationObserver === "undefined") return
  session.uncover = watchRows(rows, () => session.terminal.buffer.active as unknown as CoverBuffer)
}

/** Starts or stops the readers of every open terminal; `coverSecrets` calls it. */
export function coverTerminals(on: boolean): void {
  covering = on
  for (const session of terminals.values()) {
    if (on && session.element) cover(session)
    else {
      session.uncover?.()
      session.uncover = undefined
    }
  }
}

/**
 * Whether copying the selection now would take a blurred line off the screen
 * in the clear: during a take, a selection that reaches a line the reader
 * would not show is not copied.
 */
function copyIsCovered(terminal: Terminal): boolean {
  if (!covering) return false
  const range = terminal.getSelectionPosition()
  if (!range) return false
  try {
    return selectionReachesSecret(terminal.buffer.active as unknown as CoverBuffer, range.start.y, range.end.y)
  } catch {
    return true
  }
}

/** Ends a terminal for good. Called when its pane closes, not when it hides. */
export function disposeTerminal(id: string): void {
  const session = terminals.get(id)
  if (!session) return
  session.detach?.()
  session.terminal.dispose()
  terminals.delete(id)
}
