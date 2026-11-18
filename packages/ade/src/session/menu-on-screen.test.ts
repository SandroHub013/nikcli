import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Terminal } from "@xterm/xterm"
import { createLineAccumulator } from "../host/line-stream"
import { createLineWriter } from "../surface/pane-lines"
import { codeOf } from "../test-support/source-text"
import { typeThenEnter } from "./enter"
import { waitsForLine, formatEnterLost, formatHeldByMenu, formatHeldMenuReceipt, formatHeldSilentReceipt, formatSilentStart } from "./mailbox"
import { en as enText } from "../i18n/en"
import { it as itText } from "../i18n/it"
import { decideOpening, OPENING_TIMEOUT_MS } from "./opening"
import { detectPermission, followPermission, type PermissionRequest } from "./permission"
import { createMenuHold, createUnparsed, menuNames, screenQuestion, statusFromScreen } from "./screen-question"
import { isAnswerKey, isEnterKey, isTyping, typedAfter, type TypedLine } from "./typed-line"
import { workbenchSource } from "../test-support/workbench-source"

/*
 * Live test of 2026-11-02, FAIL 1 and 2: ADE typed mail and first tasks, Enter included, into a menu that stood on the
 * screen. The bytes below are what real ConPTY gave for the fake agent of that test (`fake3.js`, no ADE and no model),
 * read back the way a pane reads them: a real terminal and the real line stream. What is typed goes through the real
 * `typeThenEnter` and `decideOpening`.
 */

const COLS = 76
const ROWS = 21
const AGENT = "goose"

const OPENS = "\x1b[?9001h\x1b[?1004h\x1b[m\x1b]0;C:\\Windows\\System32\\cmd.exe\x07\x1b[?25h"
const FILL = Array.from({ length: 200 }, (_, n) => `filler line ${n + 1}\r\n`).join("") + "> "
const NOTES = "\r\nnote 1: reading config\r\nnote 2: 3 files\r\nnote 3: waiting for you\r\n"

// On a screen with room, ConPTY jumps over the blank row with a cursor move: no newline after «2. No».
const ON_FRESH_SCREEN =
  "\x1b[?25l\r\nRun the build command?\r\n  ❯ 1. Yes, proceed\r\n    2. No\x1b[7;1H Enter to confirm · Esc to cancel "
// On a full screen it scrolls, with newlines.
const ON_FULL_SCREEN = "\r\nRun the build command?\r\n  ❯ 1. Yes, proceed\r\n    2. No\r\n\n Enter to confirm · Esc to cancel"

// `mode=menu0`, a console already in UTF-8.
const OPENS_ON_MENU_UTF8 = [
  OPENS,
  "FAKE AGENT ready (goose)",
  "\x1b[?25l\r\n> \r\nRun the start command?\r\n  ❯ 1. Yes, proceed\r\n    2. No\x1b[7;1H Enter to confirm · Esc to cancel \x1b[?25h",
]
function written(terminal: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve))
}

/** A pane as the workbench has it: its screen, its stream, and the question of `watchForPermission`. */
function pane() {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true })
  const stream = createLineAccumulator()
  const raw: string[] = []
  let pending: PermissionRequest | undefined
  let line: TypedLine | undefined
  const hold = createMenuHold()
  const lines = createLineWriter<string>(
    () => {},
    (_id, line) => {
      raw.push(line)
      if (raw.length > 8) raw.shift()
      if (pending) pending = followPermission(pending, raw, AGENT)
      else pending = detectPermission(raw, AGENT)
    },
  )
  return {
    terminal,
    async feed(...chunks: string[]) {
      for (const chunk of chunks) {
        await written(terminal, chunk)
        lines.together(() => {
          for (const line of stream.push(chunk)) lines.watch("p", line)
        })
      }
    },
    /** A key of the user's on its way to the pane: an Enter is said before it is written (`menuEnter`). */
    async key(data: string, answer = "") {
      if (isEnterKey(data)) hold.enterTyped("p", terminal, AGENT)
      if (answer) await this.feed(answer)
    },
    /** A key as `onInput` takes it: counted (`menuOnScreen`, F2), told to the hold if an Enter, then written. */
    async type(data: string, echo = "") {
      const menu = hold.waiting("p", terminal, AGENT)
      const answers = menu !== undefined && isAnswerKey(data) && !isTyping(line) && menuNames(menu, data)
      line = typedAfter(line, data, Date.now(), answers)
      if (isEnterKey(data)) hold.enterTyped("p", terminal, AGENT)
      if (echo) await this.feed(echo)
    },
    /** What keeps mail out of the pane: `questionOpen`, or a line the user has begun. */
    mailWaits() {
      return this.questionOpen() || isTyping(line)
    },
    /** `questionOpen`, as far as the stream and the screen go. */
    questionOpen: () => pending !== undefined || hold.waiting("p", terminal, AGENT) !== undefined,
  }
}

type Pane = ReturnType<typeof pane>

/** What ADE types into the pane when it thinks it may: mail, or a first task. */
async function typedInto(p: Pane): Promise<string[]> {
  const typed: string[] = []
  await typeThenEnter({
    text: "[Messaggio da Master]: 1",
    write: (data) => void typed.push(data),
    wait: async () => {},
    alive: () => true,
    permissionOpen: p.questionOpen,
  })
  return typed
}

const opening = (p: Pane, now: number) =>
  decideOpening({ startedAt: 0, firstByteAt: 100, lastByteAt: 200, now, permissionPending: p.questionOpen() })

const startOfPane = ["FAKE AGENT ready (goose)", "\r\n> m"]

/** The screen of a process that was there before, moved away as `startOnCleanScreen` moves it. */
const CLEANED = "old process\r\n".repeat(30) + "\r\n".repeat(ROWS) + "\x1b[H"

describe("a menu with lines below it is a menu that waits", () => {
  test("ml, on a screen with room", async () => {
    const p = pane()
    await p.feed(...startOfPane, ON_FRESH_SCREEN + NOTES)
    expect(p.questionOpen()).toBe(true)
    expect(await typedInto(p)).toEqual([])
  })

  test("ml, on a full screen", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    expect(p.questionOpen()).toBe(true)
    expect(await typedInto(p)).toEqual([])
  })

  test("fml: a flood, then the menu and the lines in its last chunk", async () => {
    const p = pane()
    const flood = Array.from({ length: 3000 }, (_, n) => `L${n}:abcdefghijklmnopqrstuvwxyz\r\n`).join("")
    await p.feed(FILL, flood + "END flood" + ON_FULL_SCREEN + NOTES)
    expect(p.questionOpen()).toBe(true)
    expect(await typedInto(p)).toEqual([])
  })

  test("mla: found at once, and not lost when the lines come 3 s later", async () => {
    const p = pane()
    await p.feed(FILL, "la\r\nRun the build command?\r\n  ❯ 1. Yes, proceed\r\n    2. No\r\n")
    await p.feed("\n Enter to confirm · Esc to cancel\x1b[1C")
    expect(p.questionOpen()).toBe(true)
    await p.feed(NOTES)
    expect(p.questionOpen()).toBe(true)
    expect(await typedInto(p)).toEqual([])
  })
})

describe("an agent that opens on a menu gets nothing typed into it", () => {
  test("spawn: the first task waits", async () => {
    const p = pane()
    await p.feed(...OPENS_ON_MENU_UTF8)
    expect(opening(p, 1000)).toBe("wait")
    expect(await typedInto(p)).toEqual([])
  })

  test("relaunch with a request open: over the old process's screen, moved away", async () => {
    const p = pane()
    await written(p.terminal, CLEANED)
    await p.feed(...OPENS_ON_MENU_UTF8)
    expect(opening(p, 1000)).toBe("wait")
    expect(await typedInto(p)).toEqual([])
  })

  test("reload: the preamble waits, and the task is not given up on a timer", async () => {
    const p = pane()
    await p.feed(...OPENS_ON_MENU_UTF8)
    expect(opening(p, 1400)).toBe("wait")
    expect(opening(p, OPENING_TIMEOUT_MS * 10)).toBe("wait")
    expect(await typedInto(p)).toEqual([])
  })

  test("once the menu is gone the task goes", async () => {
    const p = pane()
    await p.feed(...OPENS_ON_MENU_UTF8)
    expect(opening(p, 1000)).toBe("wait")
    await p.feed("\x1b[2J\x1b[H> ")
    expect(opening(p, 2000)).toBe("send")
  })
})

describe("what is not a menu waiting holds nothing", () => {
  test("a numbered list in a reply, with lines below it", async () => {
    const p = pane()
    await p.feed(
      FILL,
      "\r\n● Is the plan clear?\r\n  1. Now: Codex reads the notes and maps the stages.\r\n  2. Only then do we open the second one.\r\n\r\nIf it is, say so.\r\nI will wait.\r\n> ",
    )
    expect(p.questionOpen()).toBe(false)
    expect((await typedInto(p)).length).toBe(2)
  })

  test("a list of answers in a reply, with no hint and no cursor", async () => {
    const p = pane()
    await p.feed(FILL, "\r\nThe options were?\r\n  1. Yes\r\n  2. No\r\nnote 1\r\nnote 2\r\n> ")
    expect(p.questionOpen()).toBe(false)
  })

  test("the menu has gone from the screen: a program that redraws", async () => {
    const p = pane()
    await p.feed(...startOfPane, ON_FRESH_SCREEN + NOTES)
    await p.feed("\x1b[2J\x1b[H> ")
    expect(p.questionOpen()).toBe(false)
    expect((await typedInto(p)).length).toBe(2)
  })

  test("a menu already answered, by a program that prints lines and never redraws: a digit, what it printed, its prompt", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    expect(p.questionOpen()).toBe(true)
    await p.key("1", " [1]\r\nanswered; working...\r\nworking 1/4\r\n> ")
    expect(p.questionOpen()).toBe(false)
    expect((await typedInto(p)).length).toBe(2)
  })

  test("a menu answered with an Enter that printed nothing", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    await p.key("\r")
    expect(p.questionOpen()).toBe(false)
  })

  test("a prompt under the menu: the program is taking a line", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + "\r\nanswered\r\nturn done\r\n> ")
    expect(p.questionOpen()).toBe(false)
  })

  test("a hint line under a recognised menu still works, at the bottom of the screen", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN)
    expect(screenQuestion(p.terminal, AGENT)?.what).toBe("Run the build command?")
    expect(screenQuestion(p.terminal, AGENT)?.answers.map((answer) => answer.label)).toEqual(["Yes, proceed", "No"])
  })
})

describe("a key does not release a menu that goes on waiting", () => {
  test("a key the menu ignores: nothing moved on the screen", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    await p.key("x")
    expect(p.questionOpen()).toBe(true)
    expect(await typedInto(p)).toEqual([])
  })

  test("a key into a menu that is the last thing on the screen, however the screen moves on the same row", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN)
    await p.key("x", " x")
    expect(p.questionOpen()).toBe(true)
  })

  test("the same question printed again below the first is a new menu", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    await p.key("\r", "\r\nanswered\r\n")
    expect(p.questionOpen()).toBe(false)
    await p.feed(ON_FULL_SCREEN + NOTES)
    expect(p.questionOpen()).toBe(true)
    expect(await typedInto(p)).toEqual([])
  })

  test("another menu, under one answered, is a new menu", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    await p.key("\r", "\r\nanswered\r\n")
    await p.feed(ON_FULL_SCREEN.replace("build", "second") + NOTES)
    expect(p.questionOpen()).toBe(true)
  })
})

describe("the pane says so", () => {
  const read = (waiting: boolean, wasWaiting: boolean, status: string, other = false) =>
    statusFromScreen({ waiting, wasWaiting, status, other })

  test("mla: the stream took it back to working, and the screen puts it on waiting again", () => {
    expect(read(true, true, "working")).toBe("waiting")
  })

  test("a menu the stream never had", () => {
    expect(read(true, false, "working")).toBe("waiting")
    expect(read(true, false, "idle")).toBe("waiting")
  })

  test("the menu has gone: back to working, once", () => {
    expect(read(false, true, "waiting")).toBe("working")
    expect(read(false, false, "waiting")).toBeUndefined()
  })

  test("a waiting the stream or the hook still reports is not taken back", () => {
    expect(read(false, true, "waiting", true)).toBeUndefined()
  })
})

describe("what real agents draw, with a line below it", () => {
  // A status row under the menu: Codex's approval modal and Claude Code's trust dialog as `screen-question.test.ts` has them.
  const CODEX_APPROVAL = [
    "  Would you like to run the following command?",
    "",
    "  $ bun test --conditions=browser",
    "",
    "› 1. Yes, proceed (y)",
    "  2. Yes, and don't ask again for this command (a)",
    "  3. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel",
    "  gpt-5 · 40% context left",
  ]
  const CLAUDE_TRUST = [
    " Is this a project you created or one you trust?",
    "",
    " ❯ 1. Yes, I trust this folder",
    "   2. No, exit",
    "",
    " Enter to confirm · Esc to cancel",
    "  statusline: main",
  ]
  for (const [name, rows, agent] of [
    ["codex", CODEX_APPROVAL, "codex"],
    ["claude-code", CLAUDE_TRUST, "claude-code"],
  ] as const) {
    test(name, async () => {
      const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
      await written(terminal, rows.join("\r\n"))
      expect(screenQuestion(terminal, agent)?.under).toBe(1)
    })
  }

  const AGY_BOX = [
    "╭──────────────────────────────────────────╮",
    "│ Do you want to make this edit to a.ts?   │",
    "│ › 1. Yes                                 │",
    "│   2. Yes, allow all edits                │",
    "│   3. No                                  │",
    "│                                          │",
    "╰──────────────────────────────────────────╯",
  ]

  test("agy: its box has no hint, and closes with a status row below it", async () => {
    const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
    await written(terminal, [...AGY_BOX, "  model: flash  12% used"].join("\r\n"))
    expect(screenQuestion(terminal, "agy")?.what).toBe("Do you want to make this edit to a.ts?")
    expect(screenQuestion(terminal, "agy")?.under).toBe(1)
  })

  test("the same box with no cursor in it is a box of text", async () => {
    const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
    await written(terminal, [...AGY_BOX.map((row) => row.replace("›", " ")), "  model: flash  12% used"].join("\r\n"))
    expect(screenQuestion(terminal, "agy")).toBeUndefined()
  })

  test("a CLI's idle footer with hint-like words is no menu", async () => {
    const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
    await written(terminal, "› Ask Codex to do anything\r\n\r\n  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit\r\n  esc to interrupt")
    expect(screenQuestion(terminal, "codex")).toBeUndefined()
  })
})

describe("the sender hears it is held", () => {
  const reader = { id: "n1", title: "fuoco1", agent: "goose" } as Parameters<typeof formatHeldMenuReceipt>[0]

  test("the receipt says «in coda», and why", () => {
    const receipt = formatHeldMenuReceipt(reader)
    expect(receipt.startsWith("ok: in coda")).toBe(true)
    expect(receipt).toContain("menu")
    expect(receipt).not.toContain("consegnat")
  })

  test("a first task whose session has drawn nothing by the deadline: not typed, and why", () => {
    const told = formatSilentStart("r1", reader)
    expect(told).toContain("r1")
    expect(told).toContain("non l'ha ancora digitata")
    expect(told).not.toContain("consegnat")
  })

  test("a session that has drawn nothing yet: «in coda», and why", () => {
    const receipt = formatHeldSilentReceipt(reader)
    expect(receipt.startsWith("ok: in coda")).toBe(true)
    expect(receipt).toContain("fuoco1")
    expect(receipt).toContain("non ha ancora scritto")
    expect(receipt).not.toContain("consegnat")
  })

  test("a first task, a reply or an update hears the same", () => {
    expect(formatHeldByMenu({ id: "r1", kind: "spawn" }, reader)).toContain("la richiesta r1")
    expect(formatHeldByMenu({ id: "r1", kind: "reply" }, reader)).toContain("la tua risposta alla richiesta r1")
  })
})

describe("a key the menu does not name never releases it", () => {
  test("x, and the program goes on printing under the menu", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    await p.key("x")
    await p.feed("note 4: still waiting\r\n")
    expect(p.questionOpen()).toBe(true)
    expect(await typedInto(p)).toEqual([])
  })

  test("mla: x within its 3 s, and the notes come after it", async () => {
    const p = pane()
    await p.feed(FILL, "la\r\nRun the build command?\r\n  ❯ 1. Yes, proceed\r\n    2. No\r\n")
    await p.feed("\n Enter to confirm · Esc to cancel\x1b[1C")
    await p.key("x")
    await p.feed(NOTES)
    expect(p.questionOpen()).toBe(true)
  })

  test("x, and a status row repainted in place", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + "\r\nstatus 12:00:01")
    await p.key("x")
    await p.feed("\x1b[2K\rstatus 12:00:02")
    expect(p.questionOpen()).toBe(true)
  })

  test("a digit the menu names, when all it does is move the highlight in place", async () => {
    const p = pane()
    await p.feed("Run the build command?\r\n  ❯ 1. Yes, proceed\r\n    2. No\r\n\r\n Enter to confirm · Esc to cancel\r\nstatus")
    await p.key("2")
    await p.feed("\x1b[2;1H    1. Yes, proceed\x1b[K\x1b[3;1H  ❯ 2. No\x1b[K\x1b[6;1H")
    expect(p.questionOpen()).toBe(true)
  })

  test("a digit that moves the highlight while the program prints below: the next Enter would confirm it", async () => {
    const p = pane()
    await p.feed("Run the build command?\r\n  ❯ 1. Yes, proceed\r\n    2. No\r\n\r\n Enter to confirm · Esc to cancel\r\nstatus")
    await p.key("2")
    await p.feed("\x1b[2;1H    1. Yes, proceed\x1b[K\x1b[3;1H  ❯ 2. No\x1b[K\x1b[6;1H\r\none more line\r\n")
    expect(p.questionOpen()).toBe(true)
    expect(await typedInto(p)).toEqual([])
  })

  test("a program that answers on a digit and never redraws: held until its prompt", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    await p.key("1", " [1]\r\nanswered; working...\r\nworking 1/4\r\n")
    expect(p.questionOpen()).toBe(true)
    await p.feed("> ")
    expect(p.questionOpen()).toBe(false)
  })

  test("a program that answers on a digit and never redraws: or until an Enter", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    await p.key("1", " [1]\r\nanswered; working...\r\nworking 1/4\r\n")
    expect(p.questionOpen()).toBe(true)
    await p.key("\r")
    expect(p.questionOpen()).toBe(false)
  })

  test("what a menu names: its numbers, and a letter its label shows", async () => {
    const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
    await written(terminal, "Run it?\r\n› 1. Yes, proceed (y)\r\n  2. No, and tell Codex what to do (esc)\r\n\r\n  Press enter to confirm or esc to cancel")
    const menu = screenQuestion(terminal, "codex")!
    expect(["1", "2", "y", "Y"].filter((key) => menuNames(menu, key))).toEqual(["1", "2", "y", "Y"])
    expect(["3", "x", "h", "es"].filter((key) => menuNames(menu, key))).toEqual([])
  })
})

/*
 * Alt+Enter and a declared paste carry a `\r` and send nothing: read as the Enter that answers a menu, they released one
 * that still waited, and once the line was cleared the mail's Enter went into it (re-review of menu-posta, F1).
 */
describe("what carries a return and is no Enter", () => {
  test("Alt+Enter, then a Backspace: the menu still waits", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    await p.type("\x1b\r")
    await p.type("\x7f")
    expect(p.mailWaits()).toBe(true)
    expect(await typedInto(p)).toEqual([])
  })

  test("a paste of several lines, then cleared: the menu still waits", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    await p.type("\x1b[200~one\rtwo\x1b[201~")
    await p.type("\x03")
    expect(p.mailWaits()).toBe(true)
    expect(await typedInto(p)).toEqual([])
  })

  test("an Enter is an Enter, and so is a line pasted undeclared with its own", async () => {
    for (const enter of ["\r", "yes\r"]) {
      const p = pane()
      await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
      await p.type(enter)
      expect(p.mailWaits()).toBe(false)
    }
  })
})

describe("a line the user has begun under the words of a menu", () => {
  const QUOTED =
    "\r\nThe tool drew this:\r\nRun the build command?\r\n  ❯ 1. Yes, proceed\r\n    2. No\r\n Enter to confirm · Esc to cancel\r\n\r\n> "
  const LIST = "\r\nWhich do you prefer?\r\n1. Yes\r\n2. No\r\n\r\n> "

  test("a menu quoted with its hint: h, and the mail does not land after the h", async () => {
    const p = pane()
    await p.feed(FILL, QUOTED)
    await p.type("h", "h")
    expect(p.mailWaits()).toBe(true)
  })

  test("a list of answers over a composer: the echo takes the reading away, and the h still counts", async () => {
    const p = pane()
    await p.feed(FILL, LIST)
    await p.type("h", "h")
    expect(p.mailWaits()).toBe(true)
  })

  test("the quoted menu scrolls away with the h still there", async () => {
    const p = pane()
    await p.feed(FILL, QUOTED)
    await p.type("h", "h")
    await p.feed("\r\n" + "more output\r\n".repeat(ROWS))
    expect(p.mailWaits()).toBe(true)
  })

  test("a digit as the first thing typed: its echo in the composer does not release the menu", async () => {
    const p = pane()
    await p.feed(FILL, QUOTED)
    await p.type("1", "1")
    expect(p.mailWaits()).toBe(true)
  })

  test("a digit as the first thing typed, and then lines arrive under the menu", async () => {
    const p = pane()
    await p.feed(FILL, QUOTED)
    await p.type("1", "1")
    await p.feed("\r\nmore output\r\nmore output\r\nmore output")
    expect(p.mailWaits()).toBe(true)
  })

  test("the Enter sends the line, and the mail goes", async () => {
    const p = pane()
    await p.feed(FILL, QUOTED)
    await p.type("h", "h")
    await p.type("\r", "\r\nworking\r\nworking\r\n")
    expect(p.mailWaits()).toBe(false)
  })

  test("a one-key answer the menu names is no line begun (F2)", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    await p.type("1", " [1]\r\nanswered; working...\r\nworking 1/4\r\n> ")
    expect(p.mailWaits()).toBe(false)
  })

  test("a key it does not name, into a menu that then goes: counted as a line until an Enter, the side the count errs on", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    await p.type("q", "\x1b[2J\x1b[H> ")
    expect(p.questionOpen()).toBe(false)
    expect(p.mailWaits()).toBe(true)
    await p.type("\r", "\r\n> ")
    expect(p.mailWaits()).toBe(false)
  })
})

describe("the question dialog of OpenCode, and of ragu without its plugin", () => {
  // `packages/tui/src/routes/session/question.tsx`: the active option by colour alone, free labels, its own last row.
  const DIALOG = [
    "  Which library should we use?",
    "",
    "  1. Foo",
    "     The foo library",
    "  2. Bar",
    "     The bar library",
    "  3. Type your own answer",
    "",
  ]
  const rowsOf = async (rows: readonly string[]) => {
    const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
    await written(terminal, rows.join("\r\n"))
    return screenQuestion(terminal, "opencode")
  }

  for (const hint of [
    "  ↑↓ select  enter submit  esc dismiss",
    "  ⇆ tab switch  ↑↓ select  enter confirm  esc dismiss",
    "  ↑↓ select  enter toggle  esc dismiss",
    "  ↑↓ select · enter submit · esc dismiss",
  ]) {
    test(`read by its hint: ${hint.trim()}`, async () => {
      const menu = await rowsOf([...DIALOG, hint])
      expect(menu?.what).toBe("Which library should we use?")
      expect(menu?.answers.map((answer) => answer.label)).toEqual(["Foo", "Bar", "Type your own answer"])
    })
  }

  test("its footer wrapped in a narrow pane is still its hint, down to one key on a row", async () => {
    const wrapped = await rowsOf([...DIALOG, "  ↑↓ select  enter submit", "  esc dismiss"])
    expect(wrapped?.under).toBe(0)
    const narrow = await rowsOf([...DIALOG, "  ⇆ tab switch", "  ↑↓ select", "  enter toggle", "  esc dismiss"])
    expect(narrow?.under).toBe(0)
  })

  test("with a row below it, and a digit is a key it names", async () => {
    const menu = await rowsOf([...DIALOG, "  ↑↓ select  enter submit  esc dismiss", "  flash · 12% used"])
    expect(menu?.under).toBe(1)
    expect(menuNames(menu!, "2")).toBe(true)
    expect(menuNames(menu!, "h")).toBe(false)
  })

  const PROSE = ["● Here is the plan:", "  1. Install the dependencies first.", "  2. Run the tests afterwards.", ""]
  for (const [name, rows] of [
    ["a hint that names one key", [...PROSE, "Press enter to continue"]],
    ["a sentence that starts with a key", [...PROSE, "Enter the folder, then tab to select a file"]],
    ["two keys, neither of them Enter", [...PROSE, "Esc to cancel · Tab to amend"]],
    ["ordinary prose", [...PROSE, "Then tell me how it went."]],
    [
      "numbers that do not start from 1",
      ["● The rest of the plan:", "  3. Install the dependencies first.", "  4. Run the tests afterwards.", "", "  ↑↓ select  enter submit  esc dismiss"],
    ],
    [
      "a gap in the numbers",
      ["● Which ones:", "  1. Install the dependencies first.", "  3. Run the tests afterwards.", "", "  ↑↓ select  enter submit  esc dismiss"],
    ],
  ] as const) {
    test(`a reply stays a reply: ${name}`, async () => {
      expect(await rowsOf(rows)).toBeUndefined()
    })
  }
})

describe("ragu's confirm dialog", () => {
  // `packages/tui/src/ui/dialog-confirm.tsx`: an overlay, so the session's own text may stand on the row either side.
  const DIALOG = ["  Update available", "", "  Install now?", "", "   │    Cancel    │  │    Confirm    │", "", ""]

  test("read by its hint: Y or N act at once, and a mail's first letter would be one", async () => {
    const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
    await written(terminal, [...DIALOG, "        Y/N or ←→ to switch, enter to confirm", "", "  background"].join("\r\n"))
    const menu = screenQuestion(terminal, "ragu")
    expect(menu?.under).toBe(0)
    expect(menuNames(menu!, "y")).toBe(true)
    expect(menuNames(menu!, "N")).toBe(true)
    expect(menuNames(menu!, "x")).toBe(false)
  })

  test("those words printed by another agent are no dialog of ragu's: this team's panes read this very code", async () => {
    const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
    await written(terminal, "Its hint says: Y/N or ←→ to switch, enter to confirm\r\nmore of the reply")
    expect(screenQuestion(terminal, "codex")).toBeUndefined()
    expect(screenQuestion(terminal, "claude-code")).toBeUndefined()
  })

  test("with the session's text either side of it", async () => {
    const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
    await written(terminal, "old text  │    Cancel    │  │    Confirm    │  old text\r\n\r\nold text    Y/N or ←→ to switch, enter to confirm    old text")
    expect(screenQuestion(terminal, "ragu")).toBeDefined()
  })

  test("its blank cells show what is under them, so its words are read with any character between them", async () => {
    const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
    await written(terminal, "old text  │    Cancel    │  │    Confirm    │  old text\r\n\r\nold textY/Neorc←→ptoiswitch,genter totconfirmold text")
    expect(screenQuestion(terminal, "ragu")).toBeDefined()
  })

  test("its words quoted in a ragu reply, with no buttons above them, are no dialog: nothing would ever clear it", async () => {
    const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
    await written(terminal, "Its hint says: Y/N or ←→ to switch, enter to confirm\r\nmore of the reply")
    expect(screenQuestion(terminal, "ragu")).toBeUndefined()
  })
})

describe("a menu in a box of its own: only this box counts (agy)", () => {
  const STATUS = "  model: flash  12% used"
  const box = (...inside: string[]) => ["╭" + "─".repeat(60) + "╮", ...inside.map((row) => `│ ${row.padEnd(58)} │`), "╰" + "─".repeat(60) + "╯"]
  const read = async (rows: readonly string[], cols = 100) => {
    const terminal = new Terminal({ cols, rows: 24, allowProposedApi: true })
    await written(terminal, rows.join("\r\n"))
    return screenQuestion(terminal, "agy")
  }

  test("a label that wraps inside the box", async () => {
    const menu = await read([...box("Do you want to edit a.ts?", "› 1. Yes, and allow every later edit of this file in", "     this whole session", "  2. No"), STATUS])
    expect(menu?.what).toBe("Do you want to edit a.ts?")
    expect(menu?.answers.length).toBe(2)
  })

  test("a blank row above the options, and a label over 40 characters", async () => {
    const menu = await read([...box("Do you want to edit a.ts?", "", "› 1. Yes, and allow every later edit of this file", "  2. No"), STATUS])
    expect(menu?.what).toBe("Do you want to edit a.ts?")
  })

  test("a row like a selected option above the box: the user's own message, echoed", async () => {
    const menu = await read(["› 1. fix this", "  2. fix that", "", ...box("Do you want to edit a.ts?", "› 1. Yes", "  2. No"), STATUS])
    expect(menu?.what).toBe("Do you want to edit a.ts?")
    expect(menu?.answers.map((answer) => answer.label)).toEqual(["Yes", "No"])
  })

  test("an answered box above a new one: the new one is read, and its question is new to the hold", async () => {
    const hold = createMenuHold()
    const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
    await written(terminal, [...box("Do you want to edit a.ts?", "› 1. Yes", "  2. No"), STATUS].join("\r\n"))
    hold.enterTyped("p", terminal, "agy")
    await written(terminal, "\r\nedited a.ts\r\n" + [...box("Do you want to edit b.ts?", "› 1. Yes", "  2. No"), STATUS].join("\r\n"))
    expect(screenQuestion(terminal, "agy")?.what).toBe("Do you want to edit b.ts?")
    expect(hold.waiting("p", terminal, "agy")?.what).toBe("Do you want to edit b.ts?")
  })

  test("two cursors in the same box are not a menu, and a box of text with no cursor neither", async () => {
    expect(await read([...box("Pick?", "› 1. Yes", "› 2. No"), STATUS])).toBeUndefined()
    expect(await read([...box("Notes", "  1. read the file", "  2. fix it"), STATUS])).toBeUndefined()
  })
})

describe("what xterm has not parsed yet", () => {
  test("a pane is behind from the chunk it was given until xterm has parsed it, and the screen does not know yet", async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
    const unparsed = createUnparsed()
    const parsed = new Promise<void>((resolve) => {
      terminal.write(ON_FULL_SCREEN, () => {
        unparsed.parsed("p")
        resolve()
      })
      unparsed.fed("p")
    })
    expect(screenQuestion(terminal, AGENT)).toBeUndefined()
    expect(unparsed.behind("p")).toBe(true)
    await parsed
    expect(unparsed.behind("p")).toBe(false)
    expect(screenQuestion(terminal, AGENT)).toBeDefined()
  })

  test("two chunks: behind until the last, and a late callback after a forget does no harm", () => {
    const unparsed = createUnparsed()
    unparsed.fed("p")
    unparsed.fed("p")
    unparsed.parsed("p")
    expect(unparsed.behind("p")).toBe(true)
    unparsed.parsed("p")
    expect(unparsed.behind("p")).toBe(false)
    unparsed.fed("p")
    unparsed.forget("p")
    unparsed.parsed("p")
    expect(unparsed.behind("p")).toBe(false)
  })
})

describe("a menu with no question above it", () => {
  const MENU = "  ❯ 1. Yes, proceed\r\n    2. No\r\n\r\n Enter to confirm · Esc to cancel\r\nnote\r\n"

  test("printed again below the first, it is a new menu", async () => {
    const terminal = new Terminal({ cols: COLS, rows: 40, allowProposedApi: true })
    const hold = createMenuHold()
    await written(terminal, MENU)
    expect(screenQuestion(terminal, AGENT)?.what).toBe("")
    hold.enterTyped("p", terminal, AGENT)
    await written(terminal, "\r\nanswered\r\n")
    expect(hold.waiting("p", terminal, AGENT)).toBeUndefined()
    // Far enough below that the words above it are no question of its own, and with more under it than the key saw.
    await written(terminal, "\r\n".repeat(13) + MENU + "note 2\r\nnote 3\r\n")
    expect(screenQuestion(terminal, AGENT)?.what).toBe("")
    expect(hold.waiting("p", terminal, AGENT)).toBeDefined()
  })
})

describe("lint: the workbench's wiring", () => {
  const source = codeOf(workbenchSource())
  const between = (from: string, to: string) => {
    const start = source.indexOf(codeOf(from))
    expect(start).toBeGreaterThanOrEqual(0)
    return source.slice(start, source.indexOf(codeOf(to), start))
  }

  test("lint: a question open answers the sender and tells the pane, before any delivery", () => {
    const branch = between("if (heldByQuestion(target.pane.id)) {", "const targetDepth")
    expect(branch).toContain(codeOf("noteHeldByMenu(target.pane.id)"))
    expect(branch).toContain(codeOf("formatHeldMenuReceipt(target.pane)"))
    expect(branch).toContain(codeOf("return false"))
  })

  test("lint: the screen is read after xterm has parsed each chunk", () => {
    const feed = between("const feedTerminal = (", "const addProject")
    expect(feed).toContain(codeOf("watchScreen(paneId)"))
    expect(feed).toContain(codeOf("if (!writeToTerminal(paneId, chunk, written)) {"))
  })

  test("lint: a chunk counts as unparsed from before its write until xterm calls back, or refuses it", () => {
    const feed = between("const feedTerminal = (", "const addProject")
    expect(feed.indexOf(codeOf("unparsed.fed(paneId)"))).toBeGreaterThanOrEqual(0)
    expect(feed.indexOf(codeOf("unparsed.fed(paneId)"))).toBeLessThan(feed.indexOf(codeOf("writeToTerminal(paneId, chunk, written)")))
    expect(feed.split(codeOf("unparsed.parsed(paneId)")).length).toBe(3)
    expect(between("const forgetPane = (", "rawWindows.forget(id)")).toContain(codeOf("unparsed.forget(id)"))
  })

  test("lint: every key on its way to a pane reaches the hold before it is written", () => {
    const renderer = readFileSync(new URL("../surface/pane-renderer.tsx", import.meta.url), "utf8")
    const onInput = renderer.slice(renderer.indexOf("onInput={(data) => {"))
    const told = onInput.indexOf("if (isEnterKey(data)) deps.menuEnter(current().id)")
    expect(told).toBeGreaterThan(0)
    expect(told).toBeLessThan(onInput.indexOf("session.write(data)"))
    // The composer sends its line with an Enter of its own.
    const composer = renderer.slice(renderer.indexOf("onSubmit={"))
    expect(composer.indexOf("deps.menuEnter(current().id)")).toBeGreaterThan(0)
    expect(composer.indexOf("deps.menuEnter(current().id)")).toBeLessThan(composer.indexOf("?.write(`${line}\\r`)"))
    expect(between("const turnSubmitted = (", "claims.evidence(paneId)")).not.toContain(codeOf("menuEnter(paneId)"))
    expect(between("const answerPermission = (", "appendLine(paneId")).toContain(codeOf("menuEnter(paneId)"))
  })

  test("lint: on a screen's word alone, only a key the menu names is not the start of a line", () => {
    const body = between("const menuOnScreen = (", "const screenMenu = (")
    expect(body).toContain(codeOf("menu !== undefined && menuNames(menu, key)"))
    expect(readFileSync(new URL("../surface/pane-renderer.tsx", import.meta.url), "utf8")).toContain(
      "deps.menuOpen(current().id, data)",
    )
  })

  test("lint: a dialog of ragu's holds a line like any question: the offer, the click, the first task and the mail all ask here", () => {
    expect(source).toContain(codeOf("isQuestionOpen(permissions()[paneId], activityOf.get(paneId)) || modeTracker.heldOpen(paneId) || screenAsks(paneId) || dialogUp(paneId)"))
    const up = between("const dialogUp =", "const questionOpen =")
    expect(up).toContain(codeOf('hasTerminal(paneId) && dialogOver(getTerminal(paneId).terminal, pane?.agent ?? pane?.model ?? "")'))
  })

  test("lint: the note about a question goes when the question has gone, and a later one tells the pane again, but not the sender", () => {
    const poll = between("if (starting.typesTask) {", "openingPolls.add(poll)")
    expect(poll).toContain(codeOf("} else if (menuTold && !trustHandled && drawn) {"))
    expect(poll).toContain(codeOf("menuTold = false dropPaneNote(paneId, menuNote)"))
    expect(poll).toContain(codeOf("if (request && !senderHeard) { senderHeard = true"))
  })

  test("lint: over a dialog of ragu's the note says how to close it, and follows what is on the screen", () => {
    expect(source).toContain(codeOf('const note = t(dialogUp(paneId) ? "note.mailHeldByDialog" : "note.mailHeldByMenu")'))
    const poll = between("if (starting.typesTask) {", "openingPolls.add(poll)")
    expect(poll).toContain(codeOf('const note = t(dialogUp(paneId) ? "task.heldByDialog" : "task.heldByMenu")'))
    expect(poll).toContain(codeOf("if (menuTold && !trustHandled && drawn && note !== menuNote) { dropPaneNote(paneId, menuNote) tellPane(paneId, note) menuNote = note }"))
  })

  test("lint: when the focus-in mark stands, noteMailHeld tells note.mailHeldByDialog", () => {
    const noteHeld = between("const noteMailHeld =", "const newProcessOnPane =")
    expect(noteHeld).toContain(codeOf("refocusedNow(getTerminal(paneId).terminal)"))
    expect(noteHeld).toContain(codeOf('tellPane(paneId, t("note.mailHeldByDialog"))'))
  })

  test.each([
    ["it", itText],
    ["en", enText],
  ])("the notes over a dialog name Esc, because an Enter there picks what is highlighted: %s", (_language, text) => {
    for (const key of ["note.mailHeldByDialog", "task.heldByDialog"] as const) {
      expect(text[key]).toContain("Esc")
      expect(text[key]).not.toMatch(/Invio|Enter/)
    }
  })

  test("lint: the line ADE itself is typing is no line begun, and the note about a line goes when the line has", () => {
    expect(source).toContain(codeOf("const byLine = waitsForLine(lineBegun(target.pane.id), linesInFlight.has(target.pane.id))"))
    const held = between("const byLine =", "if (message.kind")
    expect(held).toContain(codeOf('if (!byLine && heldByLineNoted.delete(target.pane.id)) dropPaneNote(target.pane.id, t("note.mailHeldByLine"))'))
  })

  test("lint: a line that stays after its Enter is said to the pane and to the sender, and no Enter goes by itself", () => {
    const typed = between("const typeLineNow = async (", "const enterStuck = new WeakSet")
    expect(typed).toContain(codeOf("if (lineAtEnter !== undefined) void watchLineStays(paneId, session, typedAt, lineAtEnter)"))
    expect(typed).toContain(codeOf("stuck = shown === \"stuck\" lineAtEnter = boxLine(boxPane)"))
    const watch = between("const watchLineStays = async (", "const enterStuck = new WeakSet")
    expect(watch).toContain(codeOf('tellPane(paneId, t("note.enterLost"))'))
    expect(watch).toContain(codeOf("tellSender(sender.from, formatEnterLost(sender.id,"))
    expect(watch).toContain(codeOf('dropPaneNote(paneId, t("note.enterLost"))'))
    expect(watch).not.toContain("pressAgain")
    expect(watch).not.toContain(".write(")
    expect(source).toContain(codeOf('if (outcome === "sent" && meta.from) lineSender.set(session, { from: meta.from, id: meta.id })'))
  })

  test("mail waits for a line begun, and not for the line ADE itself is typing: a turn comes after that one", () => {
    expect(waitsForLine(true, false)).toBe(true)
    expect(waitsForLine(true, true)).toBe(false)
    expect(waitsForLine(false, false)).toBe(false)
    expect(waitsForLine(false, true)).toBe(false)
  })

  test("the sender hears the message has not gone, and whose box it is in", () => {
    const said = formatEnterLost("r7", { id: "p", title: "oc2", agent: "ragu" } as never)
    expect(said).toContain("r7")
    expect(said).toContain("oc2")
    expect(said).toContain("non è partito")
  })

  test.each([
    ["it", itText, "Invio"],
    ["en", enText, "Enter"],
  ])("the note says what to do with the line: %s", (_language, text, key) => {
    expect(text["note.enterLost"]).toContain(key)
  })

  test("lint: the first task asks the screen on every pass, and says what it waits for", () => {
    const poll = between("if (starting.typesTask) {", "openingPolls.add(poll)")
    expect(poll).toContain(codeOf('const asked = box !== "ready" && questionOpen(paneId)'))
    expect(poll).toContain(codeOf("permissionPending: boxHolds || asked || unparsed.behind(paneId)"))
    expect(poll).toContain(codeOf('t("task.heldByMenu")'))
  })

  test("lint: the opening's clock is the helpers', from the first text, and starts again after a question", () => {
    const poll = between("if (starting.typesTask) {", "openingPolls.add(poll)")
    expect(poll).toContain(codeOf("...clockAfterMenu({ startedAt, ...openingBytes }, menuAt),"))
    expect(poll).toContain(codeOf("const drawn = screenDrawn(openingBytes, Date.now())"))
    expect(source).toContain(codeOf("openingBytes = bytesAfter(openingBytes, chunk, now)"))
  })

  test("lint: the deadline does not end a first task's poll: it is said once, to the pane and to the sender", () => {
    const poll = between("if (starting.typesTask) {", "openingPolls.add(poll)")
    expect(poll).toContain(codeOf("const step = openingStep(decision, silenceTold, openingBytes)"))
    const told = poll.slice(poll.indexOf(codeOf('if (step === "tell") {')), poll.indexOf(codeOf("stopOpeningPoll(poll)if (menuTold)")))
    expect(told).toContain(codeOf('tellPane(paneId, t("task.notSent"))'))
    expect(told).toContain(codeOf("tellSender(request.from, formatSilentStart(request.id, reader))"))
    // It ends in its own return, so the pass that says it does not stop the poll.
    expect(told.endsWith(codeOf("return }"))).toBe(true)
  })

  test("lint: the note about the silence goes with the silence, even if a menu is what came, and with the process", () => {
    const poll = between("if (starting.typesTask) {", "openingPolls.add(poll)")
    const over = poll.slice(poll.indexOf(codeOf("if (silenceTold && openingBytes.firstByteAt !== undefined) {")))
    expect(over.startsWith(codeOf('if (silenceTold && openingBytes.firstByteAt !== undefined) { silenceTold = false dropPaneNote(paneId, t("task.notSent")) }'))).toBe(true)
    // Before the question is read: a menu drawn first has its own note.
    expect(poll.indexOf(codeOf("if (silenceTold && openingBytes.firstByteAt"))).toBeLessThan(poll.indexOf(codeOf('const asked = box !== "ready" && questionOpen(paneId)')))
    const stopped = poll.slice(poll.indexOf(codeOf("if (running.get(paneId) !== session) {")), poll.indexOf(codeOf("const drawn = screenDrawn")))
    expect(stopped).toContain(codeOf("if (menuTold) dropPaneNote(paneId, menuNote)"))
    expect(stopped).toContain(codeOf('if (silenceTold) dropPaneNote(paneId, t("task.notSent"))'))
  })

  test("lint: mail waits for the first text too, and a silence past the deadline is said once", () => {
    expect(source).toContain(codeOf("nothingDrawn: running.has(paneId) && undrawnSince.has(paneId),"))
    const feed = between("const feedTerminal = (", "const addProject")
    expect(feed).toContain(codeOf("if (undrawnSince.has(paneId) && drawsText(chunk)) {"))
    expect(feed).toContain(codeOf('if (heldBySilenceNoted.delete(paneId)) dropPaneNote(paneId, t("note.mailHeldBySilence"))'))
    for (const start of [between("const startProcess = async (", "const startRemoteProcess = async ("), between("const startRemoteProcess = async (", "openingPolls.add(poll)")]) {
      expect(start).toContain(codeOf("undrawnSince.set(paneId, Date.now())"))
    }
    const held = between("const byLine =", "if (message.kind")
    expect(held).toContain(codeOf('tellPane(target.pane.id, t("note.mailHeldBySilence"))'))
    expect(held).toContain(codeOf("(silentFor(target.pane.id) ?? 0) >= OPENING_TIMEOUT_MS"))
    expect(held).toContain(codeOf("formatHeldSilentReceipt(target.pane)"))
    expect(between("const forgetPane = (", "rawWindows.forget(id)")).toContain(codeOf("undrawnSince.delete(id)"))
  })

  test("lint: a first task refused at the last moment is said, on both of its paths", () => {
    const poll = between("if (starting.typesTask) {", "openingPolls.add(poll)")
    expect(poll).toContain(codeOf('t("task.notTyped")'))
    expect(poll).toContain(codeOf("if (!host) return void typeOpening()"))
    expect(poll).toContain(codeOf("else void typeOpening()"))
    expect(poll).not.toContain(codeOf("typeLine(session, opening)"))
  })

  test("lint: a remote session forgets the hold and the note, reads the first text, and says a step held for long", () => {
    const remote = between("const startRemoteProcess = async (", "openingPolls.add(poll)")
    expect(remote).toContain(codeOf("menuHold.forget(paneId)"))
    expect(remote).toContain(codeOf("dropHeldByMenu(paneId)"))
    expect(remote).toContain(codeOf("if (drawsText(chunk)) textAt = Date.now()"))
    expect(remote).toContain(codeOf("Date.now() - stepStart >= REMOTE_STEP_NOTE_MS"))
    expect(remote).toContain(codeOf('t("task.stepHeld", String(steps[index]))'))
    expect(remote).toContain(codeOf('if (stepHeldTold) dropPaneNote(paneId, t("task.stepHeld", text))'))
    expect(remote).toContain(codeOf("permissionPending: asking"))
  })

  test("lint: a restart forgets the note of the process before it", () => {
    const local = between("const startProcess = async (", "const startRemoteProcess = async (")
    expect(local).toContain(codeOf("dropHeldByMenu(paneId)"))
    expect(local).toContain(codeOf('dropPaneNote(paneId, t("task.heldByMenu")) dropPaneNote(paneId, t("task.heldByDialog")) dropPaneNote(paneId, t("task.notSent"))'))
  })
})
