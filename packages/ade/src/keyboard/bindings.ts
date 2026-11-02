/**
 * Default keyboard bindings for ADE.
 *
 * Declarative map from chord strings to command ids. The chord strings use the
 * `mod` alias (Cmd on mac, Ctrl elsewhere) so that a single table covers both
 * platforms.
 *
 * This file is pure data — no logic beyond what `parseChord` provides. The
 * test file verifies that no two bindings collide and that every entry has a
 * non-empty command id.
 */

import { type Binding, parseChord, type Platform } from "./keymap"

export interface BindingEntry {
  /** Human chord string, e.g. "mod+shift+p" */
  chord: string
  /** Target command id */
  commandId: string
}

/**
 * The default ADE bindings as raw data.
 *
 * Order matters: earlier entries shadow later ones in `resolveBinding`, so
 * more-specific bindings should come first.
 */
export const DEFAULT_BINDINGS: BindingEntry[] = [
  // Palette
  { chord: "mod+shift+p", commandId: "palette.open" },

  // Sessions
  { chord: "mod+n", commandId: "session.new" },

  // Pane management
  { chord: "mod+w", commandId: "pane.close" },
  { chord: "mod+shift+m", commandId: "pane.expand" },
  { chord: "f2", commandId: "pane.rename" },

  // Views and theme
  { chord: "mod+shift+v", commandId: "view.toggle" },
  { chord: "mod+shift+t", commandId: "theme.toggle" },
  /*
   * B for the bar, with Shift: Ctrl+B belongs to what runs in the terminal
   * (tmux's prefix, readline's back-a-character), and xterm sends nothing at
   * all for Ctrl+Shift+a letter, so this one takes no key from a program.
   */
  { chord: "mod+shift+b", commandId: "sidebar.toggle" },
]

/**
 * Commands a chord does not run while a text field has the focus.
 *
 * A Ctrl chord in a field is otherwise read as a command, which is right for
 * the palette and wrong for a close: Ctrl+W typed in a composer, out of the
 * habit of deleting a word, closed the pane and ended the agent in it (review
 * of the frontend, ALTO 6).
 */
export const NOT_FROM_TEXT_FIELDS: ReadonlySet<string> = new Set(["pane.close"])

/**
 * Commands a chord runs even while a terminal has the focus.
 *
 * Every other ADE chord goes to the terminal there (see the keydown handler
 * in the workbench): Ctrl+W deletes a word, Ctrl+N walks the history,
 * Ctrl+Shift+V pastes, F2 is a function key some TUIs read.
 *
 * What is here is what xterm turns into nothing: Ctrl+Shift+a letter sends no
 * byte (no kitty protocol in xterm 6), so these chords take no key from the
 * program. The terminal is where the user is almost all the time, so a
 * shortcut that only works outside it is a shortcut that does not work: the
 * palette, the expanded pane, the theme and the sidebar are asked for from
 * inside a session more than from anywhere else.
 *
 * Ctrl+Shift+V is not here although it is the same shape: it is the paste.
 */
export const FROM_TERMINALS: ReadonlySet<string> = new Set([
  "palette.open",
  "pane.expand",
  "theme.toggle",
  "sidebar.toggle",
])

/**
 * What a Cmd chord may add on a Mac.
 *
 * `mod` is Cmd there, and a terminal reads Ctrl and Alt but never Cmd: xterm
 * sends no byte for Cmd+a letter, so a new session from inside a session
 * takes nothing from the program. Cmd+W (it ends the agent), Cmd+Shift+V (the
 * paste, which WebKit reads) and F2 (no Cmd in it at all) stay out.
 */
const FROM_TERMINALS_ON_MAC: ReadonlySet<string> = new Set(["session.new"])

/**
 * Whether the chord bound to `commandId` is ADE's while a terminal has the focus.
 *
 * Plain Ctrl+letter, Ctrl+C, Ctrl+V and the Ragu queue's keys (Esc,
 * Ctrl+Enter) are in no binding, so they never reach this question: they go to
 * the pane. Only a chord that is bound can be asked about, and only the ones
 * named above answer yes.
 */
export function runsFromTerminal(commandId: string, platform: Platform): boolean {
  if (FROM_TERMINALS.has(commandId)) return true
  return platform === "mac" && FROM_TERMINALS_ON_MAC.has(commandId)
}

/**
 * Whether a key event runs its command.
 *
 * Only the first press: held down, the key repeats, and an expanded pane flipping at the repeat rate resizes the pty in a
 * storm and redraws every TUI in it, a theme flips back and forth, and a new session opens dozens of times. The repeat is
 * still swallowed, so it does not reach what has the focus.
 */
export function firesOnPress(event: { repeat?: boolean }): boolean {
  return event.repeat !== true
}

/*
 * Moving focus between panes is deliberately absent from this list. The grid
 * measures its own columns and already answers Alt+Arrow with the real
 * geometry; a second binding here would either duplicate that or, worse,
 * swallow the arrow keys with a guess about the layout.
 *
 * Bindings for commands nobody implements are absent for a sharper reason: the
 * listener calls preventDefault on anything it resolves, so an unimplemented
 * binding does not do nothing — it takes the key away from whatever would have
 * handled it.
 */

/**
 * Resolve the raw binding entries into platform-specific `Binding` objects.
 *
 * Called once at init and cached — the list is short enough that a linear scan
 * on every keystroke would also be fine, but there's no reason to parse the
 * chord strings more than once.
 */
export function resolveDefaultBindings(platform: Platform): Binding[] {
  return DEFAULT_BINDINGS.map((entry) => ({
    chord: parseChord(entry.chord, platform),
    commandId: entry.commandId,
  }))
}
