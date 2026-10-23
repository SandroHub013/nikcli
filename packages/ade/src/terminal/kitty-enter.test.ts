import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createTerminalKeyHandler, kittyEnter } from "./registry"

/*
 * ragu-pannelli-0211: xterm.js sends the plain `\r` for Enter with any modifier, so ragu's TUI (kitty keyboard
 * protocol, OpenTUI) could not tell Shift+Enter (newline) or Ctrl+Enter (send now) from a send. In a ragu pane the
 * two keys go as `CSI 13;2u` and `CSI 13;5u`; in every other pane nothing changes.
 */

const CTRL_ENTER = "\u001b[13;5u"
const SHIFT_ENTER = "\u001b[13;2u"

/** A terminal that records what `input` was given, and has no selection. */
function fakeTerminal() {
  const inputs: { data: string; user: boolean | undefined }[] = []
  const terminal = {
    input: (data: string, user?: boolean) => void inputs.push({ data, user }),
    hasSelection: () => false,
  }
  return { terminal: terminal as any, inputs }
}

const key = (type: string, init: KeyboardEventInit) => new KeyboardEvent(type, { key: "Enter", ...init })

describe("kittyEnter: which keys become a sequence", () => {
  test("Ctrl+Enter and Shift+Enter alone", () => {
    expect(kittyEnter({ key: "Enter", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })).toBe(CTRL_ENTER)
    expect(kittyEnter({ key: "Enter", ctrlKey: false, shiftKey: true, altKey: false, metaKey: false })).toBe(SHIFT_ENTER)
  })

  test("a plain Enter, other keys and every other combination are left to xterm", () => {
    const base = { key: "Enter", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
    expect(kittyEnter(base)).toBeUndefined()
    expect(kittyEnter({ ...base, ctrlKey: true, shiftKey: true })).toBeUndefined()
    expect(kittyEnter({ ...base, ctrlKey: true, altKey: true })).toBeUndefined()
    expect(kittyEnter({ ...base, shiftKey: true, metaKey: true })).toBeUndefined()
    expect(kittyEnter({ ...base, key: "a", ctrlKey: true })).toBeUndefined()
    expect(kittyEnter({ ...base, key: "Tab", shiftKey: true })).toBeUndefined()
  })
})

describe("the key handler of a ragu pane", () => {
  test("Ctrl+Enter and Shift+Enter are typed as their sequences, through the typed-key door, and xterm sends nothing more", () => {
    const { terminal, inputs } = fakeTerminal()
    const handler = createTerminalKeyHandler(terminal, undefined, undefined, () => true)
    expect(handler(key("keydown", { ctrlKey: true }))).toBe(false)
    expect(handler(key("keydown", { shiftKey: true }))).toBe(false)
    // `wasUserInput` true: the same route as a key the user typed, so the pane's `onData` and the typed-line count see it.
    expect(inputs).toEqual([
      { data: CTRL_ENTER, user: true },
      { data: SHIFT_ENTER, user: true },
    ])
  })

  test("sent once per press: the keypress and the keyup that follow are kept from xterm and send nothing", () => {
    const { terminal, inputs } = fakeTerminal()
    const handler = createTerminalKeyHandler(terminal, undefined, undefined, () => true)
    for (const init of [{ ctrlKey: true }, { shiftKey: true }]) {
      expect(handler(key("keydown", init))).toBe(false)
      // Without this the keypress of Enter reaches xterm and sends its own `\r` after the sequence.
      expect(handler(key("keypress", init))).toBe(false)
      expect(handler(key("keyup", init))).toBe(false)
    }
    expect(inputs.map((entry) => entry.data)).toEqual([CTRL_ENTER, SHIFT_ENTER])
  })

  test("a plain Enter and the other combinations pass through to xterm", () => {
    const { terminal, inputs } = fakeTerminal()
    const handler = createTerminalKeyHandler(terminal, undefined, undefined, () => true)
    expect(handler(key("keydown", {}))).toBe(true)
    expect(handler(key("keydown", { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(handler(key("keydown", { altKey: true }))).toBe(true)
    expect(inputs).toEqual([])
  })

  test("while the user composes with an input method the Enter is the method's", () => {
    const { terminal, inputs } = fakeTerminal()
    const handler = createTerminalKeyHandler(terminal, undefined, undefined, () => true)
    expect(handler(key("keydown", { shiftKey: true, isComposing: true }))).toBe(true)
    expect(inputs).toEqual([])
  })
})

describe("every other pane keeps what it had", () => {
  test("a shell, Claude Code, OpenCode and the rest: no option, or an option that says no, and Enter is xterm's", () => {
    for (const handlerFor of [
      (terminal: any) => createTerminalKeyHandler(terminal),
      (terminal: any) => createTerminalKeyHandler(terminal, undefined, undefined, undefined),
      (terminal: any) => createTerminalKeyHandler(terminal, undefined, undefined, () => false),
    ]) {
      const { terminal, inputs } = fakeTerminal()
      const handler = handlerFor(terminal)
      expect(handler(key("keydown", { ctrlKey: true }))).toBe(true)
      expect(handler(key("keydown", { shiftKey: true }))).toBe(true)
      expect(handler(key("keypress", { shiftKey: true }))).toBe(true)
      expect(inputs).toEqual([])
    }
  })

  test("the copy shortcuts and the voice chords are as they were beside the new option", () => {
    const { terminal } = fakeTerminal()
    const handler = createTerminalKeyHandler(terminal, undefined, undefined, () => true)
    // Ctrl+C with no selection is the program's SIGINT; Mod+Shift+J is the window's.
    expect(handler(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(true)
    expect(handler(new KeyboardEvent("keydown", { key: "j", ctrlKey: true, shiftKey: true }))).toBe(false)
  })
})

describe("who is given the option", () => {
  const read = (...parts: string[]) => readFileSync(join(import.meta.dir, ...parts), "utf8")

  test("only a pane whose agent is ragu says yes, and the terminal reads the pane's answer when the key is pressed", () => {
    const pane = read("..", "grid", "pane.tsx")
    expect(pane).toContain('kittyKeys: () => (props.agent ?? props.model) === "ragu"')
    // Not the other agents' lines.
    expect(pane.match(/kittyKeys:/g)).toHaveLength(1)
    const registry = read("registry.ts")
    expect(registry).toContain("() => created.kittyKeys?.() ?? false,")
    expect(registry).toContain("session.kittyKeys = options.kittyKeys")
    // A pane that lets go of the terminal takes its answer with it.
    expect(registry).toContain("session.kittyKeys = undefined")
  })
})
