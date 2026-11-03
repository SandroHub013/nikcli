import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Terminal } from "@xterm/xterm"
import { createLineAccumulator } from "../host/line-stream"
import { createLineWriter } from "../surface/pane-lines"
import { codeOf } from "../test-support/source-text"
import { typeThenEnter } from "./enter"
import { formatHeldByMenu, formatHeldMenuReceipt } from "./mailbox"
import { decideOpening, OPENING_TIMEOUT_MS } from "./opening"
import { detectPermission, followPermission, type PermissionRequest } from "./permission"
import { createMenuHold, screenQuestion, statusFromScreen } from "./screen-question"

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
/*
 * The same, as it happened in the live test: the raw UTF-8 of `fs.writeSync` on a console still on its OEM code page.
 * Mid-turn the same menu came out whole, because `ade-msg inbox` had run in that console: `ade-msg.ps1` sets
 * `[Console]::OutputEncoding` to UTF-8 (`mailbox.rs`), and that stays for the console.
 */
const OPENS_ON_MENU_OEM = OPENS_ON_MENU_UTF8.map((chunk) => chunk.replace("❯", "ÔØ»").replace("·", "┬À"))

function written(terminal: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve))
}

/** A pane as the workbench has it: its screen, its stream, and the question of `watchForPermission`. */
function pane() {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true })
  const stream = createLineAccumulator()
  const raw: string[] = []
  let pending: PermissionRequest | undefined
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
    /** A key of the user's on its way to the pane (`menuKey`), written after it is said. */
    async key(data: string, answer = "") {
      hold.keyTyped("p", terminal, AGENT, data.includes("\r"))
      if (answer) await this.feed(answer)
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
  for (const [name, chunks] of [
    ["a console in UTF-8", OPENS_ON_MENU_UTF8],
    ["menu0 as in the live test: raw UTF-8 on the OEM code page", OPENS_ON_MENU_OEM],
  ] as const) {
    describe(name, () => {
      test("spawn: the first task waits", async () => {
        const p = pane()
        await p.feed(...chunks)
        expect(opening(p, 1000)).toBe("wait")
        expect(await typedInto(p)).toEqual([])
      })

      test("relaunch with a request open: over the old process's screen, moved away", async () => {
        const p = pane()
        await written(p.terminal, CLEANED)
        await p.feed(...chunks)
        expect(opening(p, 1000)).toBe("wait")
        expect(await typedInto(p)).toEqual([])
      })

      test("reload: the preamble waits, and the task is not given up on a timer", async () => {
        const p = pane()
        await p.feed(...chunks)
        expect(opening(p, 1400)).toBe("wait")
        expect(opening(p, OPENING_TIMEOUT_MS * 10)).toBe("wait")
        expect(await typedInto(p)).toEqual([])
      })
    })
  }

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

  test("a menu already answered, by a program that prints lines and never redraws: a digit, then what it printed", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    expect(p.questionOpen()).toBe(true)
    await p.key("1", " [1]\r\nanswered; working...\r\nworking 1/4\r\n")
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
    await p.key("1", " [1]\r\nanswered\r\n")
    expect(p.questionOpen()).toBe(false)
    await p.feed(ON_FULL_SCREEN + NOTES)
    expect(p.questionOpen()).toBe(true)
    expect(await typedInto(p)).toEqual([])
  })

  test("another menu, under one answered, is a new menu", async () => {
    const p = pane()
    await p.feed(FILL, "ml", ON_FULL_SCREEN + NOTES)
    await p.key("1", " [1]\r\nanswered\r\n")
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

  test("a first task, a reply or an update hears the same", () => {
    expect(formatHeldByMenu({ id: "r1", kind: "spawn" }, reader)).toContain("la richiesta r1")
    expect(formatHeldByMenu({ id: "r1", kind: "reply" }, reader)).toContain("la tua risposta alla richiesta r1")
  })
})

describe("lint: the workbench's wiring", () => {
  const source = codeOf(readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8"))
  const between = (from: string, to: string) => {
    const start = source.indexOf(codeOf(from))
    expect(start).toBeGreaterThanOrEqual(0)
    return source.slice(start, source.indexOf(codeOf(to), start))
  }

  test("lint: a question open answers the sender and tells the pane, before any delivery", () => {
    const branch = between("if (questionOpen(target.pane.id)) {", "const targetDepth")
    expect(branch).toContain(codeOf("noteHeldByMenu(target.pane.id)"))
    expect(branch).toContain(codeOf("formatHeldMenuReceipt(target.pane)"))
    expect(branch).toContain(codeOf("return false"))
  })

  test("lint: the screen is read after xterm has parsed each chunk", () => {
    const feed = between("const feedTerminal = (", "const addProject")
    expect(feed).toContain(codeOf("watchScreen(paneId)"))
    expect(feed).toContain(codeOf("if (!writeToTerminal(paneId, chunk, written)) discardNotes.refused(paneId)"))
  })

  test("lint: every key on its way to a pane reaches the hold before it is written", () => {
    expect(between("const turnSubmitted = (", "promptAnswered(paneId)")).toContain(codeOf("menuKey(paneId, true)"))
    expect(between("const promptAnswered = (", "const pane =")).toContain(codeOf("menuKey(paneId)"))
    expect(between("const answerPermission = (", "appendLine(paneId")).toContain(codeOf("menuKey(paneId, true)"))
  })

  test("lint: the first task asks the screen on every pass, and says what it waits for", () => {
    const poll = between("if (starting.typesTask) {", "openingPolls.add(poll)")
    expect(poll).toContain(codeOf("const asked = questionOpen(paneId)"))
    expect(poll).toContain(codeOf("permissionPending: asked"))
    expect(poll).toContain(codeOf('t("task.heldByMenu")'))
  })
})
