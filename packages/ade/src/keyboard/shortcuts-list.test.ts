import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { it as itCatalog } from "../i18n/it"
import { en as enCatalog } from "../i18n/en"
import { findTab } from "../settings/categories"
import { DEFAULT_BINDINGS, runsFromTerminal } from "./bindings"
import { formatChord, parseChord } from "./keymap"
import { shortcutGroups } from "./shortcuts-list"

const group = (platform: "mac" | "other", id: string) => shortcutGroups(platform).find((g) => g.id === id)!
const keysOf = (platform: "mac" | "other", id: string) => group(platform, id).rows.map((row) => row.keys)

describe("the shortcuts page", () => {
  test("lists each bound chord in the group the workbench's own rule puts it in", () => {
    for (const platform of ["other", "mac"] as const) {
      const anywhere = keysOf(platform, "anywhere")
      const outside = keysOf(platform, "outside")
      for (const entry of DEFAULT_BINDINGS) {
        const written = formatChord(parseChord(entry.chord, platform), platform)
        const wanted = runsFromTerminal(entry.commandId, platform) ? anywhere : outside
        const other = wanted === anywhere ? outside : anywhere
        expect(wanted).toContain(written)
        expect(other).not.toContain(written)
      }
    }
  })

  test("on Windows and Linux: the four chords that answer from a terminal, then the ones that do not", () => {
    expect(keysOf("other", "anywhere")).toEqual(["Ctrl+Shift+P", "Ctrl+Shift+M", "Ctrl+Shift+T", "Ctrl+Shift+B"])
    expect(keysOf("other", "outside")).toEqual(["Ctrl+N", "Ctrl+W", "F2", "Ctrl+Shift+V"])
  })

  test("on a Mac the new session answers from a terminal too, and the symbols are the Mac's", () => {
    expect(keysOf("mac", "anywhere")).toEqual(["⇧⌘P", "⌘N", "⇧⌘M", "⇧⌘T", "⇧⌘B"])
    expect(keysOf("mac", "outside")).toEqual(["⌘W", "F2", "⇧⌘V"])
    expect(keysOf("mac", "grid")[0]).toBe("⌥←↑↓→")
  })

  test("lists «Consegna ora» under the search for commands, the keyboard's way to it (UX2-2)", () => {
    for (const platform of ["other", "mac"] as const) {
      const row = group(platform, "other").rows.find((candidate) => candidate.labelKey === "shortcuts.other.deliverNow")
      expect(row?.keys).toBe(formatChord(parseChord("mod+shift+p", platform), platform))
    }
    const palette = DEFAULT_BINDINGS.find((entry) => entry.commandId === "palette.open")
    expect(palette?.chord).toBe("mod+shift+p")
  })

  test("names the grid's keys, the terminal's mouse and the sidebar's row menu", () => {
    expect(keysOf("other", "grid")).toEqual(["Alt+←↑↓→", "Alt+Shift+←↑↓→", "←↑↓→", "Home"])
    expect(keysOf("other", "other")).toContain("Shift+F10")
    expect(keysOf("other", "terminal").some((keys) => keys.startsWith("Shift+"))).toBe(true)
    // xterm forces a selection with Option on a Mac, not Shift.
    expect(keysOf("mac", "terminal")[0]!.startsWith("⌥")).toBe(true)
  })

  test("every label is in both catalogs, and the tab is reachable in Settings › General", () => {
    for (const platform of ["other", "mac"] as const) {
      for (const g of shortcutGroups(platform)) {
        expect(g.titleKey in itCatalog).toBe(true)
        expect(g.titleKey in enCatalog).toBe(true)
        if (g.noteKey) expect(g.noteKey in itCatalog && g.noteKey in enCatalog).toBe(true)
        for (const row of g.rows) {
          expect(row.labelKey in itCatalog).toBe(true)
          expect(row.labelKey in enCatalog).toBe(true)
        }
      }
    }
    expect(findTab("general/shortcuts")?.category.id).toBe("general")
  })
})

/*
 * The keys written by hand are read against the code that implements them, so a key removed there is
 * removed from the page too.
 */
describe("the hand-written keys exist where the page says they do", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

  test("Alt+Arrow and Alt+Shift+Arrow are the grid's", () => {
    const grid = read("../grid/session-grid.tsx")
    expect(grid).toContain("!event.altKey || event.shiftKey")
    expect(grid).toContain("!event.altKey || !event.shiftKey")
  })

  test("the resize handle takes the focus and the arrows, and Home", () => {
    const grid = read("../grid/session-grid.tsx")
    expect(grid).toContain("tabindex={0}")
    expect(grid).toContain('event.key === "Home"')
    expect(grid).toContain("resizeByKey(")
  })

  test("Shift+F10 opens a row's menu", () => {
    expect(read("../sidebar/sidebar.tsx")).toContain('key.key === "F10" && key.shiftKey')
  })

  test("Ctrl+Enter and Shift+Enter reach a Ragu Code pane as their own keys", () => {
    const registry = read("../terminal/registry.ts")
    expect(registry).toContain('event.ctrlKey && !event.shiftKey) return "\\u001b[13;5u"')
    expect(registry).toContain('event.shiftKey && !event.ctrlKey) return "\\u001b[13;2u"')
  })

  test("a click opens a link in ADE and Ctrl or Cmd sends it out", () => {
    expect(read("../terminal/links.ts")).toContain("event.ctrlKey || event.metaKey")
  })
})
