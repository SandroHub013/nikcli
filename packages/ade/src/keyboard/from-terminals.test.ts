import { describe, expect, test } from "bun:test"
import { resolveVoiceOrAdeKey } from "../voice/shortcuts"
import { DEFAULT_VOICE_SETTINGS } from "@ragu/voice/core"
import { DEFAULT_BINDINGS, FROM_TERMINALS, resolveDefaultBindings, runsFromTerminal } from "./bindings"
import type { KeyInput, Platform } from "./keymap"

/*
 * The question the workbench asks when a key is pressed with a terminal in
 * focus: does this key belong to ADE, or to the program in the pane?
 *
 * Asked the way the workbench asks it: the event is resolved against the
 * default bindings first (`resolveVoiceOrAdeKey`), and only a bound chord can
 * then be ADE's (`runsFromTerminal`). A key no binding names never gets that
 * far, so it reaches the pane.
 */

const event = (key: string, mods: Partial<Omit<KeyInput, "key">> = {}): KeyInput => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

/** What the pane does with the key: `ade` when ADE takes it from the terminal, `pane` when the program keeps it. */
function ownerInTerminal(input: KeyInput, platform: Platform): "ade" | "pane" {
  const resolution = resolveVoiceOrAdeKey(resolveDefaultBindings(platform), DEFAULT_VOICE_SETTINGS, input, platform)
  if (resolution.type !== "ade") return "pane"
  return runsFromTerminal(resolution.commandId ?? "", platform) ? "ade" : "pane"
}

describe("on Windows and Linux (Ctrl)", () => {
  const ctrlShift = { ctrlKey: true, shiftKey: true }

  test("the palette, the expanded pane, the theme and the sidebar answer from inside a terminal", () => {
    expect(ownerInTerminal(event("P", ctrlShift), "other")).toBe("ade")
    expect(ownerInTerminal(event("M", ctrlShift), "other")).toBe("ade")
    expect(ownerInTerminal(event("T", ctrlShift), "other")).toBe("ade")
    expect(ownerInTerminal(event("B", ctrlShift), "other")).toBe("ade")
  })

  test("Ctrl+N, Ctrl+W, F2 and the paste stay with the program", () => {
    // Ctrl+N walks a shell's history, Ctrl+W deletes a word, F2 is a function key a TUI may read.
    expect(ownerInTerminal(event("n", { ctrlKey: true }), "other")).toBe("pane")
    expect(ownerInTerminal(event("w", { ctrlKey: true }), "other")).toBe("pane")
    expect(ownerInTerminal(event("F2"), "other")).toBe("pane")
    // Ctrl+Shift+V is the terminal's paste.
    expect(ownerInTerminal(event("V", ctrlShift), "other")).toBe("pane")
  })

  test("the keys a terminal needs are in no binding, so every one reaches the pane", () => {
    expect(ownerInTerminal(event("c", { ctrlKey: true }), "other")).toBe("pane")
    expect(ownerInTerminal(event("v", { ctrlKey: true }), "other")).toBe("pane")
    expect(ownerInTerminal(event("Escape"), "other")).toBe("pane")
    expect(ownerInTerminal(event("Enter", { ctrlKey: true }), "other")).toBe("pane")
    // tmux's prefix and readline's back-a-character, and every other plain Ctrl+letter.
    for (const letter of "abdefghijklopqrstuxyz") {
      expect(ownerInTerminal(event(letter, { ctrlKey: true }), "other")).toBe("pane")
    }
  })

  test("Cmd chords are not Ctrl chords", () => {
    expect(ownerInTerminal(event("P", { metaKey: true, shiftKey: true }), "other")).toBe("pane")
  })

  test("an Italian keyboard: the capital the layout reports still meets the chord, AltGr does not", () => {
    // Shift gives «P»; the chord is stored as «p».
    expect(ownerInTerminal({ ...event("P", ctrlShift), code: "KeyP" }, "other")).toBe("ade")
    // AltGr is Ctrl+Alt on Windows: it types «@» or «#» and must not open anything.
    expect(ownerInTerminal(event("@", { ctrlKey: true, altKey: true }), "other")).toBe("pane")
    expect(ownerInTerminal(event("P", { ...ctrlShift, altKey: true }), "other")).toBe("pane")
  })
})

describe("on macOS (Cmd)", () => {
  const cmdShift = { metaKey: true, shiftKey: true }

  test("the same four answer, and so does a new session, since a terminal never reads Cmd", () => {
    expect(ownerInTerminal(event("P", cmdShift), "mac")).toBe("ade")
    expect(ownerInTerminal(event("M", cmdShift), "mac")).toBe("ade")
    expect(ownerInTerminal(event("T", cmdShift), "mac")).toBe("ade")
    expect(ownerInTerminal(event("B", cmdShift), "mac")).toBe("ade")
    expect(ownerInTerminal(event("n", { metaKey: true }), "mac")).toBe("ade")
  })

  test("a close, a rename and the paste stay with the pane", () => {
    expect(ownerInTerminal(event("w", { metaKey: true }), "mac")).toBe("pane")
    expect(ownerInTerminal(event("F2"), "mac")).toBe("pane")
    expect(ownerInTerminal(event("V", cmdShift), "mac")).toBe("pane")
  })

  test("Ctrl is the program's on a Mac: Ctrl+Shift+P opens nothing", () => {
    expect(ownerInTerminal(event("P", { ctrlKey: true, shiftKey: true }), "mac")).toBe("pane")
    expect(ownerInTerminal(event("c", { ctrlKey: true }), "mac")).toBe("pane")
  })
})

describe("the set", () => {
  test("holds only commands that are bound, and never a close", () => {
    const bound = new Set(DEFAULT_BINDINGS.map((binding) => binding.commandId))
    for (const id of FROM_TERMINALS) expect(bound.has(id)).toBe(true)
    expect(FROM_TERMINALS.has("pane.close")).toBe(false)
    expect(FROM_TERMINALS.has("session.new")).toBe(false)
    expect(FROM_TERMINALS.has("pane.rename")).toBe(false)
    expect(FROM_TERMINALS.has("view.toggle")).toBe(false)
  })

  test("every chord in it is a Ctrl+Shift+letter, the shape xterm sends nothing for", () => {
    for (const entry of DEFAULT_BINDINGS) {
      if (!FROM_TERMINALS.has(entry.commandId)) continue
      expect(entry.chord).toMatch(/^mod\+shift\+[a-z]$/)
    }
  })
})
