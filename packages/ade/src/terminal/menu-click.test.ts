import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CONFIRM_MS,
  claudeMenu,
  menuStep,
  registerMenuClicks,
  type MenuTerminal,
  type PendingChoice,
} from "./menu-click"

/*
 * Mouse sessions, step B: a click on a Claude Code menu. The screens are the
 * ones recorded from Claude Code 2.1.283 in a pty (ade-team/results/mouse-sessioni-misura.md).
 */

// `/model`, as Claude drew it at 120 columns.
const MODEL = [
  "  specify with --model.",
  "    1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks",
  "  ❯ 2.  Opus 5.5 ✔             Most capable for ambitious work",
  "    3.  Fable 5.1              For your toughest challenges",
  "    4.  Sonnet 5               Most efficient for everyday tasks",
  "    5.  Haiku 4.5              Fastest for quick answers",
  "    6.  Opus 5                 Best for everyday, complex tasks",
  "    7.  Fable 5                Most capable for your hardest and longest-running tasks",
  "    8.  Opus 4.8               Best for everyday, complex tasks",
  "  ↓ 9.  Opus 4.7               Best for everyday, complex tasks",
  "     … +2 models",
  "  ● High effort ←/→ to adjust",
  "  Use /fast to turn on Fast mode (Opus 5.5).",
  "  Enter to set as default · s to use this session only · Esc to cancel",
  "",
]

// A permission question: the third entry carries the hint.
const PERMISSION = [
  "────────────────────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   rm build/out.txt",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for rm commands in this folder",
  "   3. No, and tell Claude what to do differently (esc)",
  "",
]

/** `rows` with the «❯» moved to entry `number`. */
function markedAt(rows: readonly string[], number: number): string[] {
  const entry = new RegExp(`^(\\s{1,2})[ ↑↓]( ${number}\\.)`)
  return rows.map((row) => {
    const plain = row.replace("❯", " ")
    return entry.test(plain) ? plain.replace(entry, "$1❯$2") : plain
  })
}

describe("claudeMenu reads a Claude Code menu, and nothing else", () => {
  test("`/model`: nine entries, the second marked", () => {
    const menu = claudeMenu(MODEL)!
    expect(menu.options.map((option) => option.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(menu.current).toEqual({ number: 2, row: 2, label: "Opus 5.5 ✔             Most capable for ambitious work" })
    expect(menu.options[8]!.row).toBe(9)
  })

  test("a permission question, the hint in its last entry", () => {
    const menu = claudeMenu(PERMISSION)!
    expect(menu.options.map((option) => option.number)).toEqual([1, 2, 3])
    expect(menu.current.number).toBe(1)
  })

  test("a numbered list typed in the prompt, inside its frame, is not a menu", () => {
    const rule = "─".repeat(100)
    expect(
      claudeMenu([
        "● Done.",
        rule,
        "❯ 1. fix the lint",
        "  2. then the tests (esc)",
        rule,
        "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
      ]),
    ).toBeUndefined()
  })

  /*
   * `/export`, recorded from Claude Code 2.1.283 in a pty; in a pane the
   * prompt's frame, with the session's name, stays under it (Verifiche, test 2).
   */
  const frame = `${"─".repeat(90)} Sessione 1 — Claude Code ─`
  const EXPORT = [
    "❯ /export",
    "─".repeat(120),
    "  Export conversation",
    "  Select export method",
    "  ❯ 1. Copy to clipboard  Copy the conversation to your system clipboard",
    "    2. Save to file       Save the conversation to a file in the current directory",
    "  Esc to cancel",
  ]

  test("`/export`, as Claude draws it, and with the prompt's frame left under it", () => {
    for (const rows of [EXPORT, [...EXPORT, "", frame, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"]]) {
      const menu = claudeMenu(rows)!
      expect(menu.options.map((option) => [option.number, option.row])).toEqual([
        [1, 4],
        [2, 5],
      ])
      expect(menu.current.number).toBe(1)
    }
    expect(menuStep([...EXPORT, frame], 5, undefined, 0)).toMatchObject({ kind: "move", keys: "\x1b[B" })
  })

  test("a rule under the entries before any «Esc to …» still means the prompt's frame", () => {
    expect(claudeMenu([...EXPORT.slice(0, 6), frame, "  Esc to cancel"])).toBeUndefined()
  })

  test("a list typed in the prompt stays ignored, even with «Esc to cancel» typed under it", () => {
    const rule = "─".repeat(100)
    expect(claudeMenu(["● Done.", rule, "❯ 1. fix the lint", "  2. then the tests", rule])).toBeUndefined()
    expect(
      claudeMenu(["● Done.", rule, "❯ 1. fix the lint", "  2. then the tests", "  Esc to cancel", rule]),
    ).toBeUndefined()
  })

  test("a numbered list in Claude's answer, with no «❯» on it, is not a menu", () => {
    expect(claudeMenu(["● Steps:", "  1. build", "  2. test", "  3. ship", "", "  Esc to interrupt"])).toBeUndefined()
  })

  test("two «❯», or none, is not a menu", () => {
    expect(claudeMenu(["  ❯ 1. a", "  ❯ 2. b", "  Esc to cancel"])).toBeUndefined()
    expect(claudeMenu(["    1. a", "    2. b", "  Esc to cancel"])).toBeUndefined()
  })

  test("entries not numbered one after the other, or out of one column, are not a menu", () => {
    expect(claudeMenu(["  ❯ 1. a", "    3. b", "  Esc to cancel"])).toBeUndefined()
    expect(claudeMenu(["  ❯ 1. a", "            2. b", "  Esc to cancel"])).toBeUndefined()
  })

  test("without an Esc hint it is not a menu", () => {
    expect(claudeMenu(MODEL.filter((row) => !row.includes("Esc")))).toBeUndefined()
  })

  test("a menu with many rows under it is not at the bottom, and is an old one", () => {
    const later = Array.from({ length: 12 }, (_, i) => `● line ${i}`)
    expect(claudeMenu([...PERMISSION, ...later])).toBeUndefined()
  })
})

describe("menuStep: a first click moves, a second on the same entry confirms", () => {
  test("the first click on entry 4 sends two arrows down, and never a digit", () => {
    const step = menuStep(MODEL, 4, undefined, 1_000)
    expect(step).toEqual({
      kind: "move",
      keys: "\x1b[B\x1b[B",
      pending: { number: 4, label: "Sonnet 5               Most efficient for everyday tasks", at: 1_000 },
    })
    expect(step.kind === "move" && /\d/.test(step.keys.replace(/\x1b\[[AB]/g, ""))).toBe(false)
  })

  test("up is up, and application mode sends ESC O", () => {
    expect(menuStep(MODEL, 1, undefined, 0)).toMatchObject({ kind: "move", keys: "\x1b[A" })
    expect(menuStep(MODEL, 3, undefined, 0, "application")).toMatchObject({ kind: "move", keys: "\x1bOB" })
  })

  test("the second click on the same entry, now marked, sends Enter", () => {
    const first = menuStep(MODEL, 4, undefined, 1_000)
    if (first.kind !== "move") throw new Error("expected a move")
    expect(menuStep(markedAt(MODEL, 4), 4, first.pending, 3_000)).toEqual({ kind: "confirm", keys: "\r" })
  })

  test("a first click on the entry already marked only arms it: no Enter", () => {
    const step = menuStep(MODEL, 2, undefined, 0)
    expect(step).toMatchObject({ kind: "move", keys: "" })
  })

  test("a second click on another entry moves again, and does not confirm", () => {
    const first = menuStep(MODEL, 4, undefined, 0)
    if (first.kind !== "move") throw new Error("expected a move")
    expect(menuStep(markedAt(MODEL, 4), 5, first.pending, 2_000)).toMatchObject({ kind: "move", keys: "\x1b[B" })
  })

  test("a second click after the wait has run out moves nothing and confirms nothing", () => {
    const pending: PendingChoice = {
      number: 4,
      label: "Sonnet 5               Most efficient for everyday tasks",
      at: 0,
    }
    expect(menuStep(markedAt(MODEL, 4), 4, pending, CONFIRM_MS + 1)).toEqual({
      kind: "move",
      keys: "",
      pending: { ...pending, at: CONFIRM_MS + 1 },
    })
  })

  test("a second click before Claude redrew sends nothing, not the arrows again", () => {
    const first = menuStep(MODEL, 4, undefined, 0)
    if (first.kind !== "move") throw new Error("expected a move")
    expect(menuStep(MODEL, 4, first.pending, 200)).toEqual({ kind: "move", keys: "", pending: first.pending })
  })

  test("the entry changed under the second click (another question): no Enter", () => {
    const pending: PendingChoice = { number: 2, label: "Opus 5.5 ✔             Most capable for ambitious work", at: 0 }
    const step = menuStep(markedAt(PERMISSION, 2), 7, pending, 2_000)
    expect(step.kind).not.toBe("confirm")
  })

  test("a click beside the entries, or on a screen that is not a menu, does nothing", () => {
    expect(menuStep(MODEL, 10, undefined, 0)).toEqual({ kind: "none" })
    expect(menuStep(MODEL, 13, undefined, 0)).toEqual({ kind: "none" })
    expect(menuStep(["$ ls", "  1. a", "  2. b"], 1, undefined, 0)).toEqual({ kind: "none" })
  })
})

/** A terminal showing `screen`, as `registerMenuClicks` reads it. */
function fakeTerminal(
  screen: { rows: string[] },
  over: Partial<{ mode: string; selected: boolean; scrolled: boolean }> = {},
) {
  const terminal: MenuTerminal = {
    get rows() {
      return screen.rows.length
    },
    modes: { mouseTrackingMode: over.mode ?? "none", applicationCursorKeysMode: false },
    buffer: {
      active: {
        viewportY: over.scrolled ? 0 : 5,
        baseY: 5,
        getLine: (y: number) => {
          const text = screen.rows[y - (over.scrolled ? 0 : 5)]
          return text === undefined ? undefined : { translateToString: () => text }
        },
      },
    },
    hasSelection: () => over.selected ?? false,
  }
  return terminal
}

/** A pane of one pixel per row, 10 px tall rows. */
function paneElement(rows: number): HTMLElement {
  const element = document.createElement("div")
  const screen = document.createElement("div")
  screen.className = "xterm-screen"
  screen.getBoundingClientRect = () => ({ top: 0, left: 0, width: 800, height: rows * 10 }) as DOMRect
  element.appendChild(screen)
  document.body.appendChild(element)
  return element
}

function click(element: HTMLElement, row: number, init: MouseEventInit = {}) {
  const at = { clientX: 50, clientY: row * 10 + 5, button: 0, bubbles: true, ...init }
  element.dispatchEvent(new MouseEvent("mousedown", at))
  element.dispatchEvent(new MouseEvent("mouseup", at))
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("registerMenuClicks: plain clicks on Claude Code's menu, nothing more", () => {
  test("two clicks on an entry: arrows, then, once redrawn, Enter", async () => {
    const screen = { rows: [...MODEL] }
    const sent: string[] = []
    let clock = 0
    const element = paneElement(screen.rows.length)
    const stop = registerMenuClicks(fakeTerminal(screen), element, {
      enabled: () => true,
      send: (keys) => sent.push(keys),
      now: () => clock,
    })
    click(element, 5)
    await settle()
    expect(sent).toEqual(["\x1b[B\x1b[B\x1b[B"])
    screen.rows = markedAt(MODEL, 5)
    clock = 2_000
    click(element, 5)
    await settle()
    expect(sent).toEqual(["\x1b[B\x1b[B\x1b[B", "\r"])
    stop()
    click(element, 6)
    await settle()
    expect(sent.length).toBe(2)
  })

  test("not Claude Code, a program with the mouse, a selection, a modifier, a drag, a scrolled view: nothing", async () => {
    const cases: [Partial<{ mode: string; selected: boolean; scrolled: boolean }>, boolean, MouseEventInit][] = [
      [{}, false, {}],
      [{ mode: "vt200" }, true, {}],
      [{ selected: true }, true, {}],
      [{}, true, { shiftKey: true }],
      [{}, true, { ctrlKey: true }],
      [{}, true, { altKey: true }],
      [{}, true, { button: 2 }],
      [{ scrolled: true }, true, {}],
    ]
    for (const [over, enabled, init] of cases) {
      const sent: string[] = []
      const element = paneElement(MODEL.length)
      const stop = registerMenuClicks(fakeTerminal({ rows: [...MODEL] }, over), element, {
        enabled: () => enabled,
        send: (keys) => sent.push(keys),
      })
      click(element, 5, init)
      await settle()
      expect(sent).toEqual([])
      stop()
    }
    const sent: string[] = []
    const element = paneElement(MODEL.length)
    registerMenuClicks(fakeTerminal({ rows: [...MODEL] }), element, { enabled: () => true, send: (k) => sent.push(k) })
    element.dispatchEvent(new MouseEvent("mousedown", { clientX: 50, clientY: 55, button: 0, bubbles: true }))
    element.dispatchEvent(new MouseEvent("mouseup", { clientX: 90, clientY: 55, button: 0, bubbles: true }))
    await settle()
    expect(sent).toEqual([])
  })
})

describe("the pane turns menu clicks on for Claude Code only", () => {
  test("attachTerminal wires them through onInput, the pane asks for claude-code", () => {
    const dir = import.meta.dir
    const registry = readFileSync(join(dir, "registry.ts"), "utf8")
    const pane = readFileSync(join(dir, "..", "grid", "pane.tsx"), "utf8")
    expect(registry).toMatch(
      /registerMenuClicks\(terminal, element, \{ enabled: options\.menuClicks, send: onInput \}\)/,
    )
    expect(pane).toContain('menuClicks: () => props.agent === "claude-code"')
  })
})
