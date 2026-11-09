/**
 * The shortcuts page: what ADE's keys really are.
 *
 * Derived rather than written out beside the screen: the bound chords come
 * from `DEFAULT_BINDINGS`, and which of them answer from inside a terminal is
 * `runsFromTerminal`, the same question the workbench asks on every key. A page
 * that listed a chord the keymap does not implement would teach the user
 * something false, and that drift is invisible until someone presses the key.
 *
 * The keys that belong to other code (the grid's Alt+Arrow, the sidebar's
 * Shift+F10, the terminal's Shift-drag and Ctrl-click, Ragù Code's Ctrl+Enter,
 * the digits in Decisioni) are listed here by hand, each against the place that
 * implements it, and `shortcuts-list.test.ts` reads those places so a key that
 * is removed there is removed here too.
 */

import { t } from "../i18n"
import type { I18nKey } from "../settings/categories"
import { DEFAULT_BINDINGS, runsFromTerminal } from "./bindings"
import { formatChord, parseChord, type Platform } from "./keymap"

export interface ShortcutRow {
  /** What the user presses, written for the platform. */
  keys: string
  /** The i18n key of what it does. */
  labelKey: I18nKey
}

export interface ShortcutGroup {
  id: "anywhere" | "outside" | "grid" | "terminal" | "other"
  titleKey: I18nKey
  /** A line under the title, when the group needs one. */
  noteKey?: I18nKey
  rows: readonly ShortcutRow[]
}

/** The text each bound command is listed under. */
const LABELS: Readonly<Record<string, I18nKey>> = {
  "palette.open": "shortcuts.palette.open",
  "session.new": "palette.session.new",
  "pane.close": "palette.pane.close",
  "pane.expand": "palette.pane.expand",
  "pane.rename": "palette.pane.rename",
  "view.toggle": "shortcuts.view.toggle",
  "theme.toggle": "palette.theme.toggle",
  "sidebar.toggle": "shortcuts.sidebar.toggle",
}

/** The modifiers as the platform writes them: ⌥⇧ on a Mac, `Alt+Shift+` elsewhere. */
function modifiers(platform: Platform) {
  return platform === "mac"
    ? { alt: "⌥", shift: "⇧", mod: "⌘", ctrl: "⌃" }
    : { alt: "Alt+", shift: "Shift+", mod: "Ctrl+", ctrl: "Ctrl+" }
}

export function shortcutGroups(platform: Platform): readonly ShortcutGroup[] {
  const key = modifiers(platform)
  const bound = DEFAULT_BINDINGS.flatMap((entry) => {
    const labelKey = LABELS[entry.commandId]
    if (!labelKey) return []
    return [
      {
        commandId: entry.commandId,
        row: { keys: formatChord(parseChord(entry.chord, platform), platform), labelKey } satisfies ShortcutRow,
      },
    ]
  })

  return [
    {
      id: "anywhere",
      titleKey: "shortcuts.group.anywhere",
      rows: bound.filter((b) => runsFromTerminal(b.commandId, platform)).map((b) => b.row),
    },
    {
      id: "outside",
      titleKey: "shortcuts.group.outside",
      noteKey: "shortcuts.group.outside.note",
      rows: bound.filter((b) => !runsFromTerminal(b.commandId, platform)).map((b) => b.row),
    },
    {
      id: "grid",
      titleKey: "shortcuts.group.grid",
      rows: [
        { keys: `${key.alt}←↑↓→`, labelKey: "shortcuts.grid.focus" },
        { keys: `${key.alt}${key.shift}←↑↓→`, labelKey: "shortcuts.grid.move" },
        { keys: "←↑↓→", labelKey: "shortcuts.grid.resize" },
        { keys: "Home", labelKey: "shortcuts.grid.resetSize" },
      ],
    },
    {
      id: "terminal",
      titleKey: "shortcuts.group.terminal",
      rows: [
        // xterm forces a selection with Shift, and on a Mac with Option (`macOptionClickForcesSelection`).
        {
          keys: `${platform === "mac" ? key.alt : key.shift}${t("shortcuts.key.drag")}`,
          labelKey: "shortcuts.terminal.select",
        },
        { keys: `${key.mod}${t("shortcuts.key.click")}`, labelKey: "shortcuts.terminal.link" },
        // `kittyEnter` reads the Ctrl key itself, on a Mac too.
        { keys: `${key.ctrl}Enter`, labelKey: "shortcuts.terminal.sendNow" },
        { keys: `${key.shift}Enter`, labelKey: "shortcuts.terminal.newline" },
      ],
    },
    {
      id: "other",
      titleKey: "shortcuts.group.other",
      rows: [
        { keys: `${key.shift}F10`, labelKey: "shortcuts.other.rowMenu" },
        { keys: "1–9", labelKey: "shortcuts.other.decisions" },
        { keys: t("shortcuts.key.drag"), labelKey: "shortcuts.other.shot" },
        // No chord of its own: one key that presses Enter on a screen ADE cannot read is too easy to press.
        { keys: formatChord(parseChord("mod+shift+p", platform), platform), labelKey: "shortcuts.other.deliverNow" },
      ],
    },
  ]
}
