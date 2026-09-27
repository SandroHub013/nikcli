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
 * in the workbench): Ctrl+W deletes a word, Ctrl+Shift+V pastes. Hiding the
 * sidebar is asked for from inside a session more than from anywhere else,
 * and its chord is one xterm turns into nothing.
 */
export const FROM_TERMINALS: ReadonlySet<string> = new Set(["sidebar.toggle"])

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
