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

  // Focus navigation between panes — arrow keys with mod, covering all four
  // directions. Alt would be more natural on some platforms but mod is already
  // the ADE modifier, and mixing two meta-keys for related commands is worse
  // than being slightly unconventional with one.
  { chord: "mod+arrowup", commandId: "focus.up" },
  { chord: "mod+arrowdown", commandId: "focus.down" },
  { chord: "mod+arrowleft", commandId: "focus.left" },
  { chord: "mod+arrowright", commandId: "focus.right" },

  // Views and theme
  { chord: "mod+shift+v", commandId: "view.toggle" },
  { chord: "mod+shift+t", commandId: "theme.toggle" },

  // File search
  { chord: "mod+shift+f", commandId: "files.search" },

  // Prompt
  { chord: "mod+enter", commandId: "prompt.send" },
]

/**
 * Resolve the raw binding entries into platform-specific `Binding` objects.
 *
 * Called once at init and cached — the list is short enough that a linear scan
 * on every keystroke would also be fine, but there's no reason to parse the
 * chord strings more than once.
 */
export function resolveDefaultBindings(platform: Platform): Binding[] {
  return DEFAULT_BINDINGS.map(entry => ({
    chord: parseChord(entry.chord, platform),
    commandId: entry.commandId,
  }))
}
