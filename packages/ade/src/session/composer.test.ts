import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Terminal } from "@xterm/xterm"
import { loadCapture, play, screenText, terminalFor, writtenTo } from "../test-support/live-bytes"
import { codeOf } from "../test-support/source-text"
import { AGENTS } from "../session-new/agents"
import {
  composerOf,
  cursorSaysDialog,
  enterBlocked,
  lineBegunNow,
  mayTypeNow,
  questionHolds,
  readsComposer,
  watchCursor,
  type ComposerState,
} from "./composer"
import { typeThenEnter, textInBox, BOX_READ_MS, ENTER_PATIENCE_MS, TEXT_SHOWS_WITHIN_MS } from "./enter"
import {
  BOX_QUIET_MS,
  formatEnterStuck,
  formatExitedUnsent,
  formatHeldByScreen,
  isFree,
  QUIET_FREE_MS,
  type Activity,
} from "./mailbox"
import { confirmDialog } from "./permission"
import { createMenuHold, folderTrust, bottomRows, screenQuestion } from "./screen-question"
import { typedAfter, typedSince } from "./typed-line"

/*
 * The live test of 2026-11-03 with real agents: everything ADE typed where it should not came from a shape its reading of
 * menus did not know. The bytes here are those agents' own, through a real xterm; what is asked of them is the gate
 * `typeThenEnter` asks in the workbench.
 */

const gate = (terminal: Terminal, agent: string) =>
  mayTypeNow({
    composer: composerOf(terminal, agent),
    question: screenQuestion(terminal, agent) !== undefined,
    nothingDrawn: false,
  })

/** The real road of a line, on the screen as it stands: nothing written is the gate's answer. */
async function typedOn(terminal: Terminal, agent: string): Promise<string[]> {
  const typed: string[] = []
  await typeThenEnter({
    text: "[Messaggio da Master]: y",
    write: (data) => void typed.push(data),
    wait: async () => {},
    alive: () => true,
    permissionOpen: () => !gate(terminal, agent),
    textShown: () => textInBox({ read: () => "draft", stop: () => false }),
    enterBlocked: () => enterBlocked(composerOf(terminal, agent), false),
  })
  return typed
}

/** Every frame of a capture that shows `words`: the gate stays shut on each, and there has to be at least one. */
async function shutWhile(
  name: string,
  agent: string,
  words: string,
  size?: { cols: number; rows: number },
  /** The dialog is closed and its rows are not yet all repainted, while this shows. */
  over?: string,
) {
  const opened: { at: number; state: ComposerState | undefined }[] = []
  let frames = 0
  await play(
    name,
    (terminal, at) => {
      const screen = screenText(terminal)
      if (!screen.includes(words) || (over !== undefined && screen.includes(over))) return
      frames++
      if (gate(terminal, agent)) opened.push({ at, state: composerOf(terminal, agent) })
    },
    size,
  )
  expect(frames).toBeGreaterThan(0)
  expect(opened).toEqual([])
}

describe("n. 1: Claude Code's trust dialog", () => {
  test("nothing goes while it stands, in any frame", async () => {
    await shutWhile("claude-fiducia", "claude-code", "trust this folder")
  })

  test("the frame ADE typed on then: no text, and no Enter that would pick «No, exit»", async () => {
    const terminal = await play("claude-fiducia", () => {})
    expect(screenText(terminal)).toContain("No, exit")
    expect(await typedOn(terminal, "claude-code")).toEqual([])
  })

  test("the reading of menus sees it: the pane says so, and it is no screen ADE cannot read", async () => {
    const terminal = await play("claude-fiducia", () => {})
    expect(screenQuestion(terminal, "claude-code")?.answers.map((answer) => answer.label)).toEqual([
      "No, exit",
      "Yes, I trust this folder",
    ])
    // «No, exit» is selected, so ADE's own worktree does not get its Enter either (`openingTrust`).
    expect(folderTrust(bottomRows(terminal), "claude-code")).toEqual({ yesSelected: false })
  })

  test("«Yes» from the user: the box comes, and the task goes", async () => {
    const states: (ComposerState | undefined)[] = []
    await play("claude-fiducia-si", (terminal) => states.push(composerOf(terminal, "claude-code")))
    expect(states).toContain("none")
    expect(states[states.length - 1]).toBe("ready")
  })
})

describe("n. 2: agy's trust dialog", () => {
  test("ADE's Enter gives no trust: nothing goes while it stands", async () => {
    await shutWhile("agy-fiducia", "agy", "trust this folder")
  })

  test("read as a question, with the yes selected", async () => {
    let read: ReturnType<typeof folderTrust>
    await play("agy-fiducia", (terminal) => {
      if (screenText(terminal).includes("trust this folder")) read = folderTrust(bottomRows(terminal), "agy")
    })
    expect(read!).toEqual({ yesSelected: true })
  })

  test("after it, the box", async () => {
    const terminal = await play("agy-fiducia", () => {})
    expect(composerOf(terminal, "agy")).toBe("ready")
  })
})

describe("n. 3: OpenCode's long question", () => {
  test("at 102 columns", async () => {
    await shutWhile("opencode-stretta-lunga", "opencode", "Foo è progettata", { cols: 102, rows: 43 })
  })

  test("at 38 columns, where it overflows the screen and shows no hint", async () => {
    await shutWhile("opencode-stretta-lunga", "opencode", "Foo è progettata", { cols: 38, rows: 21 })
  })

  test("the short question too, drawn in the same column as the box", async () => {
    await shutWhile("opencode-stretta-lunga", "opencode", "enter submit", undefined, "esc interrupt")
  })
})

describe("n. 4: ragu's DialogConfirm wrapped at 47 columns", () => {
  test("nothing goes while it stands", async () => {
    await shutWhile("ragu-conferma-47", "ragu", 'Delete "finta-due"', { cols: 47, rows: 17 })
  })

  test("a dialog with no field hides the cursor and leaves it over the box: no box", async () => {
    const terminal = terminalFor(loadCapture("claude-fiducia"), { cols: 80, rows: 8 })
    await writtenTo(terminal, "\x1b[2J\x1b[1;1H  ┃\x1b[2;1H  ┃\x1b[3;1H  ┃  Build · Grok 4.7 · xAI\x1b[2;6H")
    expect(composerOf(terminal, "ragu")).toBe("ready")
    await writtenTo(terminal, "\x1b[?25l")
    expect(composerOf(terminal, "ragu")).toBe("none")
    await writtenTo(terminal, "\x1b[?25h")
    expect(composerOf(terminal, "ragu")).toBe("ready")
  })
})

describe("n. 5: agy's box", () => {
  const at = (h: number, m: number, s: number, ms: number) => Date.UTC(2026, 10, 3, h, m, s, ms)

  test("at the two moments ADE wrote into it: the box is no composer", async () => {
    const start = loadCapture("agy-invio-nel-box").start
    const moments = [at(5, 43, 18, 407) - start, at(5, 43, 26, 425) - start]
    const seen: (ComposerState | undefined)[] = []
    await play("agy-invio-nel-box", (terminal, chunkAt, nextAt) => {
      for (const moment of moments) {
        if (chunkAt <= moment && (nextAt === undefined || moment < nextAt)) seen.push(composerOf(terminal, "agy"))
      }
    })
    expect(seen).toEqual(["none", "none"])
  })

  test("every frame of every box", async () => {
    await shutWhile("agy-invio-nel-box", "agy", "Run this command?")
  })
})

describe("n. 6: ragu's first-run wizard", () => {
  test("its first page", async () => {
    await shutWhile("ragu-procedura-guidata", "ragu", "Welcome to Ragu")
  })

  test("its next page, with the box showing through", async () => {
    await shutWhile("ragu-avvio", "ragu", "Filesystem Footprint")
  })
})

describe("n. 7: text and its Enter are not split by a change of mind", () => {
  const FILL = Array.from({ length: 200 }, (_, n) => `filler line ${n + 1}\r\n`).join("") + "> "
  const MENU = "\r\nRun the build command?\r\n  ❯ 1. Yes, proceed\r\n    2. No\r\n\n Enter to confirm · Esc to cancel"
  const NOTES = "\r\nnote 1: reading config\r\nnote 2: 3 files\r\nnote 3: waiting for you\r\n"
  const ANSWERED = " [1]\r\nanswered; working...\r\nworking 1/4\r\n> "

  async function answeredMenu() {
    const terminal = new Terminal({ cols: 76, rows: 21, scrollback: 5000, allowProposedApi: true })
    await writtenTo(terminal, FILL + "ml" + MENU + NOTES + ANSWERED)
    return terminal
  }

  test("a prompt says the menu above it no longer waits, and the text ends the prompt's being bare", async () => {
    const terminal = await answeredMenu()
    const hold = createMenuHold()
    const open = () => hold.waiting("p", terminal, "goose") !== undefined
    expect(open()).toBe(false)
    const typed: string[] = []
    const outcome = await typeThenEnter({
      text: "[Messaggio da Master]: ciao",
      write: (data) => {
        if (data !== "\r") hold.lineTyped("p", terminal)
        typed.push(data)
        return writtenTo(terminal, data === "\r" ? "" : data)
      },
      wait: () => writtenTo(terminal, ""),
      alive: () => true,
      permissionOpen: open,
    })
    expect(outcome).toBe("sent")
    expect(typed).toEqual(["[Messaggio da Master]: ciao", "\r"])
  })

  test("another menu that opens during the wait still holds the Enter", async () => {
    const terminal = await answeredMenu()
    const hold = createMenuHold()
    const open = () => hold.waiting("p", terminal, "goose") !== undefined
    const typed: string[] = []
    const outcome = await typeThenEnter({
      text: "ciao",
      write: (data) => {
        if (data !== "\r") hold.lineTyped("p", terminal)
        typed.push(data)
        return writtenTo(terminal, data === "\r" ? "" : data)
      },
      wait: () =>
        writtenTo(terminal, "\r\nDelete all files?\r\n  ❯ 1. Yes\r\n    2. No\r\n Enter to confirm · Esc to cancel"),
      alive: () => true,
      permissionOpen: open,
    })
    expect(outcome).toBe("typed-no-enter")
    expect(typed).toEqual(["ciao"])
  })

  test("a key that answered a menu during the wait is no line begun; a line is", () => {
    const answered = typedAfter(undefined, "1", 100, true)
    expect(typedSince(answered, 50)).toBe(false)
    const begun = typedAfter(undefined, "h", 100, false)
    expect(typedSince(begun, 50)).toBe(true)
    expect(typedSince(begun, 150)).toBe(false)
  })
})

describe("n. 9: nothing is typed on a blank screen", () => {
  test("an agent with no box known to ADE: a reminder waits for its first text, as mail does", async () => {
    const typed: string[] = []
    const outcome = await typeThenEnter({
      text: "[Promemoria] la richiesta aspetta",
      write: (data) => void typed.push(data),
      wait: async () => {},
      alive: () => true,
      permissionOpen: () => !mayTypeNow({ composer: undefined, question: false, nothingDrawn: true }),
    })
    expect(outcome).toBe("not-typed")
    expect(typed).toEqual([])
  })

  test("a known agent: a blank screen has no box", async () => {
    const terminal = terminalFor(loadCapture("claude-fiducia"))
    await writtenTo(terminal, "\x1b[?25h\x1b[2J\x1b[H")
    expect(composerOf(terminal, "claude-code")).toBe("none")
    expect(await typedOn(terminal, "claude-code")).toEqual([])
  })
})

describe("n. 8 and 11: what is begun is read, and not counted", () => {
  test("Claude Code after a refused plan: an empty box, whatever the hook goes on saying", async () => {
    const terminal = await play("claude-piano", () => {})
    expect(composerOf(terminal, "claude-code")).toBe("ready")
    const activity: Activity = { state: "busy", at: 0 }
    const target = { hooked: true, permissionPending: false, typing: false, activity, lastOutputAt: 1_000 }
    expect(isFree(target, 1_000 + BOX_QUIET_MS - 1)).toBe(false)
    expect(isFree({ ...target, boxReady: false }, 1_000 + BOX_QUIET_MS)).toBe(false)
    expect(isFree({ ...target, boxReady: true }, 1_000 + BOX_QUIET_MS - 1)).toBe(false)
    expect(isFree({ ...target, boxReady: true }, 1_000 + BOX_QUIET_MS)).toBe(true)
    // The count says a line was begun, from the «2» that refused it. The box says none was.
    const count = typedAfter(undefined, "2", 0)
    expect(lineBegunNow(composerOf(terminal, "claude-code"), (count?.pending ?? 0) > 0)).toBe(false)
  })

  test("a hook's permission over an empty box that has stopped drawing: answered, the turn over", () => {
    const activity: Activity = { state: "permission", at: 0 }
    const target = { hooked: true, permissionPending: false, typing: false, activity, lastOutputAt: 0 }
    expect(isFree(target, BOX_QUIET_MS)).toBe(false)
    expect(isFree({ ...target, boxReady: true }, BOX_QUIET_MS)).toBe(true)
  })

  test("a turn still going keeps drawing: on the real bytes it never stands still that long", async () => {
    for (const [name, agent, turn] of [
      ["claude-piano", "claude-code", /… \(\d+s/],
      ["ragu-avvio-normale", "ragu", /esc interrompi/],
    ] as const) {
      let frames = 0
      await play(name, (terminal, at, nextAt) => {
        if (nextAt === undefined || !turn.test(screenText(terminal))) return
        frames++
        expect(nextAt - at).toBeLessThan(BOX_QUIET_MS)
      })
      expect(`${agent}:${frames > 0}`).toBe(`${agent}:true`)
    }
  })

  test("agy after the digit that answered its box", async () => {
    const start = loadCapture("agy-invio-nel-box").start
    const digitAt = Date.UTC(2026, 10, 3, 5, 43, 9, 506) - start
    const states: (ComposerState | undefined)[] = []
    await play("agy-invio-nel-box", (terminal, at) => {
      if (at > digitAt && at < digitAt + 4_000) states.push(composerOf(terminal, "agy"))
    })
    expect(states.length).toBeGreaterThan(0)
    expect(states.some((state) => state === "ready")).toBe(true)
    expect(states).not.toContain("draft")
  })

  test("ragu after the n that answered its dialog", async () => {
    const states: (ComposerState | undefined)[] = []
    await play(
      "ragu-conferma-47",
      (terminal, at) => {
        if (at > 60_000 && at < 73_000) states.push(composerOf(terminal, "ragu"))
      },
      { cols: 47, rows: 17 },
    )
    expect(states[states.length - 1]).toBe("ready")
  })

  test("a line truly begun holds: a 1 typed into OpenCode's box at 38 columns", async () => {
    let drafts = 0
    await play(
      "opencode-stretta-lunga",
      (terminal, at) => {
        if (at >= 432_000 && at < 442_000 && composerOf(terminal, "opencode") === "draft") drafts++
      },
      { cols: 38, rows: 21 },
    )
    expect(drafts).toBeGreaterThan(0)
  })
})

describe("a normal turn delivers at once: a wrong hold is as bad as a wrong send", () => {
  const AT_REST: [string, string, number][] = [
    ["claude-piano", "claude-code", 4_000],
    ["agy-invio-nel-box", "agy", 5_000],
    ["ragu-avvio-normale", "ragu", 3_000],
    ["opencode-stretta-lunga", "opencode", 8_000],
  ]

  for (const [name, agent, restAt] of AT_REST) {
    test(`${agent}: the box is ready at rest, its text shows, and the Enter goes`, async () => {
      const capture = loadCapture(name)
      const terminal = terminalFor(capture)
      let next = 0
      while (next < capture.chunks.length && capture.chunks[next]![0] <= restAt) {
        await writtenTo(terminal, capture.chunks[next]![1])
        next++
      }
      expect(composerOf(terminal, agent)).toBe("ready")
      expect(gate(terminal, agent)).toBe(true)

      const hooked = agent === "claude-code" || agent === "ragu"
      const activity: Activity = { state: "idle", at: 0 }
      expect(
        isFree(
          {
            hooked,
            permissionPending: false,
            typing: false,
            boxReady: true,
            lastOutputAt: 0,
            ...(hooked ? { activity } : {}),
          },
          hooked ? 0 : QUIET_FREE_MS,
        ),
      ).toBe(true)
    })
  }

  test("what each of them showed with a line in its box is read as a line", async () => {
    for (const [name, agent] of AT_REST) {
      const seen = new Set<ComposerState | undefined>()
      await play(name, (terminal) => seen.add(composerOf(terminal, agent)))
      expect(`${agent}:${seen.has("draft")}`).toBe(`${agent}:true`)
      expect(`${agent}:${seen.has("ready")}`).toBe(`${agent}:true`)
    }
  })

  test("Claude Code: a line that wraps over four rows, the cursor on the last", async () => {
    let wrapped = false
    await play("claude-piano", (terminal, at) => {
      if (at >= 2_653 && at < 3_000) wrapped ||= composerOf(terminal, "claude-code") === "draft"
    })
    expect(wrapped).toBe(true)
  })
})

describe("the Enter: the box that stops being empty is the sign", () => {
  const box = (rows: string[], cursor: [number, number]) => {
    const terminal = new Terminal({ cols: 80, rows: 12, allowProposedApi: true })
    const body = rows.map((row, y) => `\x1b[${y + 1};1H${row}`).join("")
    return writtenTo(terminal, `${body}\x1b[${cursor[1] + 1};${cursor[0] + 1}H`).then(() => terminal)
  }
  const RULE = "─".repeat(80)

  test("Claude Code shows a long paste as a label", async () => {
    const terminal = await box([RULE, "❯ [Pasted text #1 +12 lines]", RULE], [29, 1])
    expect(composerOf(terminal, "claude-code")).toBe("draft")
  })

  test("a text longer than the box: its first row is out of view, between the two rules", async () => {
    const terminal = await box([RULE, "  rest of a long line", "  and the end of it", RULE], [20, 2])
    expect(composerOf(terminal, "claude-code")).toBe("draft")
  })

  test("a draft whose cursor went back to the start is not an empty box", async () => {
    const terminal = await box([RULE, "❯ ciao", RULE], [2, 1])
    expect(composerOf(terminal, "claude-code")).toBe("draft")
  })

  test("opentui: a line on the row above the cursor, in the same bar", async () => {
    const terminal = await box(["  ┃  prima riga", "  ┃", "  ┃  Build · Grok 4.7 · xAI"], [5, 1])
    expect(composerOf(terminal, "ragu")).toBe("draft")
  })

  const clock = () => {
    let at = 0
    return { now: () => at, sleep: async (ms: number) => void (at += ms) }
  }

  test("a dialog over the box: the Enter waits, and goes when the box is back with the text", async () => {
    const reads: ("ready" | "draft" | "none")[] = ["none", "none", "none", "draft"]
    const { now, sleep } = clock()
    expect(await textInBox({ read: () => reads.shift()!, stop: () => false, now, sleep })).toBe("shows")
    expect(reads).toEqual([])
  })

  test("the box back and empty: the text went nowhere, no Enter", async () => {
    const { now, sleep } = clock()
    expect(await textInBox({ read: () => "ready", stop: () => false, now, sleep })).toBe("empty")
    expect(now()).toBeGreaterThanOrEqual(TEXT_SHOWS_WITHIN_MS)
    const typed: string[] = []
    const outcome = await typeThenEnter({
      text: "ciao",
      write: (data) => void typed.push(data),
      wait: async () => {},
      alive: () => true,
      permissionOpen: () => false,
      textShown: async () => "empty",
    })
    expect(outcome).toBe("not-typed")
    expect(typed).toEqual(["ciao"])
  })

  test("a box that never comes back: not for ever, at four reads a second, and no Enter", async () => {
    const { now, sleep } = clock()
    let reads = 0
    const shown = await textInBox({
      read: () => {
        reads++
        return "none"
      },
      stop: () => false,
      now,
      sleep,
    })
    expect(shown).toBe("stuck")
    expect(now()).toBeGreaterThanOrEqual(ENTER_PATIENCE_MS)
    expect(reads).toBeLessThanOrEqual(ENTER_PATIENCE_MS / BOX_READ_MS + 1)
    const typed: string[] = []
    const outcome = await typeThenEnter({
      text: "ciao",
      write: (data) => void typed.push(data),
      wait: async () => {},
      alive: () => true,
      permissionOpen: () => false,
      textShown: async () => "stuck",
    })
    expect(outcome).toBe("typed-no-enter")
    expect(typed).toEqual(["ciao"])
  })

  test("the Enter's own gate: only on a line in the box, where the box can be read", () => {
    expect(enterBlocked("draft", true)).toBe(false)
    expect(enterBlocked("ready", false)).toBe(true)
    expect(enterBlocked("none", false)).toBe(true)
    expect(enterBlocked(undefined, false)).toBe(false)
    expect(enterBlocked(undefined, true)).toBe(true)
  })
})

describe("the id a pane carries is the catalogue's (review B1)", () => {
  const idOf = (command: string) => AGENTS.find((agent) => agent.command === command)!.id

  test("the four agents whose box is read, as the catalogue names them", () => {
    for (const command of ["claude", "agy", "ragu", "opencode"]) expect(readsComposer(idOf(command))).toBe(true)
  })

  test("Claude Code's real bytes, under that id: the box at rest, and no box on its trust dialog", async () => {
    const atRest = await play("claude-fiducia-si", () => {})
    expect(composerOf(atRest, idOf("claude"))).toBe("ready")
    const dialog = await play("claude-fiducia", () => {})
    expect(composerOf(dialog, idOf("claude"))).toBe("none")
  })
})

/** A terminal whose cursor mode is followed, with `frame` drawn on it. */
async function drawn(frame: string, cols = 80, rows = 12) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true })
  watchCursor(terminal)
  await writtenTo(terminal, frame)
  return terminal
}
const rowsAt = (rows: string[], cursor: [number, number]) =>
  rows.map((row, y) => `\x1b[${y + 1};1H${row}`).join("") + `\x1b[${cursor[1] + 1};${cursor[0] + 1}H`

describe("a placeholder that wraps is still a placeholder (review B2)", () => {
  const MODEL = "  ┃  Build · Grok 4.7 · xAI"

  test("ragu's long example at the home box's width, from its real bytes: an empty box", async () => {
    const states: (ComposerState | undefined)[] = []
    await play(
      "ragu-conferma-47",
      (terminal, at) => {
        if (at < 1_600 && screenText(terminal).includes('progetto?"')) states.push(composerOf(terminal, "ragu"))
      },
      { cols: 158, rows: 17 },
    )
    expect(states.length).toBeGreaterThan(0)
    expect(new Set(states)).toEqual(new Set(["ready"]))
  })

  test("in a narrow pane, over three rows", async () => {
    const terminal = await drawn(
      rowsAt(
        ['  ┃  Chiedi qualsiasi cosa... "Qual è', "  ┃  lo stack tecnologico", '  ┃  di questo progetto?"', MODEL],
        [5, 0],
      ),
    )
    expect(composerOf(terminal, "ragu")).toBe("ready")
  })

  test("a row after its closing quote is a line", async () => {
    const terminal = await drawn(rowsAt(['  ┃  Ask anything... "Fix a TODO"', "  ┃  and this", MODEL], [5, 0]))
    expect(composerOf(terminal, "ragu")).toBe("draft")
  })

  test("a quote that never closes before the model's row is no placeholder", async () => {
    const terminal = await drawn(rowsAt(['  ┃  Ask anything... "Fix a TODO', "  ┃  and this", MODEL], [5, 0]))
    expect(composerOf(terminal, "ragu")).toBe("draft")
  })
})

describe("Claude Code's cursor can stay hidden: a remote flag decides, and position still tells (review B3)", () => {
  const RULE = "─".repeat(78)
  const CLAUDE = "claude-code"

  test("at rest, as it draws without the flag: an inverse first letter, the rest dim", async () => {
    const box = rowsAt([RULE, '❯ \x1b[7mT\x1b[27m\x1b[2mry "refactor foo"\x1b[22m', RULE, "  ? for shortcuts"], [2, 1])
    expect(composerOf(await drawn(`\x1b[?25l${box}`), CLAUDE)).toBe("ready")
  })

  test("at rest with no placeholder: an inverse blank cell", async () => {
    const box = rowsAt([RULE, "❯ \x1b[7m \x1b[27m", RULE], [2, 1])
    expect(composerOf(await drawn(`\x1b[?25l${box}`), CLAUDE)).toBe("ready")
  })

  test("a line in the box, cursor hidden, wherever the caret is", async () => {
    const after = rowsAt([RULE, "❯ ciao\x1b[7m \x1b[27m", RULE], [6, 1])
    expect(composerOf(await drawn(`\x1b[?25l${after}`), CLAUDE)).toBe("draft")
    const before = rowsAt([RULE, "❯ \x1b[7mc\x1b[27miao", RULE], [2, 1])
    expect(composerOf(await drawn(`\x1b[?25l${before}`), CLAUDE)).toBe("draft")
    const alone = rowsAt([RULE, "❯ \x1b[7mc\x1b[27m", RULE], [2, 1])
    expect(composerOf(await drawn(`\x1b[?25l${alone}`), CLAUDE)).toBe("draft")
  })

  test("a dialog parks the cursor elsewhere: no box, hidden or not", async () => {
    const dialog = rowsAt([RULE, " Do something?", " ❯ 1. Yes", "   2. No", RULE, "", "  footer"], [0, 6])
    expect(composerOf(await drawn(`\x1b[?25l${dialog}`), CLAUDE)).toBe("none")
  })

  test("on its real bytes the position alone keeps every dialog shut: with the cursor hidden, never the box", async () => {
    for (const name of ["claude-fiducia", "claude-fiducia-si", "claude-piano"]) {
      const capture = loadCapture(name)
      const terminal = terminalFor(capture)
      let hidden = false
      const follows = (to: boolean) => (params: (number | number[])[]) => {
        if (params.includes(25)) hidden = to
        return false
      }
      terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, follows(true))
      terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, follows(false))
      let frames = 0
      for (const [, chunk] of capture.chunks) {
        await writtenTo(terminal, chunk)
        if (!hidden) continue
        frames++
        expect(composerOf(terminal, CLAUDE)).toBe("none")
      }
      expect(`${name}:${frames > 0}`).toBe(`${name}:true`)
    }
  })

  test("for agy and the agents of opentui a hidden cursor stays decisive: their dialogs leave it over the box", async () => {
    const ruled = rowsAt([RULE, "> ", RULE], [2, 1])
    expect(composerOf(await drawn(ruled), "agy")).toBe("ready")
    expect(composerOf(await drawn(`\x1b[?25l${ruled}`), "agy")).toBe("none")
    const bar = rowsAt(["  ┃", "  ┃", "  ┃  Build · Grok 4.7 · xAI"], [5, 1])
    for (const agent of ["ragu", "opencode"]) {
      expect(composerOf(await drawn(bar), agent)).toBe("ready")
      expect(composerOf(await drawn(`\x1b[?25l${bar}`), agent)).toBe("none")
    }
  })

  test("lint: the panes ADE starts ask Claude Code for its cursor", () => {
    const pty = readFileSync(new URL("../../src-tauri/src/pty.rs", import.meta.url), "utf8")
    const agentEnv = pty.slice(pty.indexOf("fn agent_env("), pty.indexOf("const CLAUDE_ACCOUNT_VARS"))
    expect(agentEnv).toContain('("CLAUDE_CODE_NATIVE_CURSOR", "1")')
  })
})

describe("ragu gives its box the cursor back on a focus-in, under a dialog still open (review B4, re-review R1)", () => {
  /** A dialog over the box, in a pane wide enough for the model's row and the input column to stand left of it. */
  const FOCUS_IN = "\x1b[?1000h\x1b[?1004h\x1b[?2004h\x1b[10;6H\x1b[?25h"
  const under = "\x1b[?1049h\x1b[2J\x1b[9;3H┃\x1b[10;3H┃\x1b[11;3H┃  Build · Grok 4.7 · xAI\x1b[12;3H┃"
  const dialog = (cols: number, hint: string) =>
    `\x1b[7;${cols - 45}H│    Cancel    │  │    Confirm    │\x1b[9;${cols - 45}H${hint}`
  const mayGo = (terminal: Terminal) =>
    mayTypeNow({
      composer: composerOf(terminal, "ragu"),
      question: screenQuestion(terminal, "ragu") !== undefined,
      nothingDrawn: false,
    })

  test("the real dialog is read, in every frame of its real bytes: until now it never was", async () => {
    let frames = 0
    await play(
      "ragu-conferma-47",
      (terminal) => {
        if (!/│ +Cancel +│/.test(screenText(terminal))) return
        frames++
        expect(confirmDialog(bottomRows(terminal))).toBeDefined()
        expect(composerOf(terminal, "ragu")).toBe("none")
      },
      { cols: 47, rows: 17 },
    )
    expect(frames).toBeGreaterThan(0)
  })

  for (const cols of [101, 158]) {
    test(`at ${cols} columns, over blank rows: no box`, async () => {
      const hint = "Y/N or ←→ to switch, enter to confirm"
      const terminal = await drawn(`${under}${dialog(cols, hint)}\x1b[14;46H\x1b[?25l${FOCUS_IN}`, cols, 17)
      expect(composerOf(terminal, "ragu")).toBe("none")
      expect(mayGo(terminal)).toBe(false)
    })

    test(`at ${cols} columns, over a reply: its blank cells show what is under them, and it is still no box`, async () => {
      const hint = "Y/Neorc←→ptoiswitch,genter totconfirm"
      const terminal = await drawn(`${under}${dialog(cols, hint)}\x1b[14;46H\x1b[?25l${FOCUS_IN}`, cols, 17)
      expect(composerOf(terminal, "ragu")).toBe("none")
      expect(mayGo(terminal)).toBe(false)
    })
  }

  test("the same frame with no dialog is the box", async () => {
    const terminal = await drawn(`${under}${FOCUS_IN}`, 158, 17)
    expect(composerOf(terminal, "ragu")).toBe("ready")
  })

  test("a reply that quotes the hint is no dialog: nothing there holds the mail", async () => {
    const terminal = await drawn(
      `${under}\x1b[3;3HIts hint says: Y/N or ←→ to switch, enter to confirm${FOCUS_IN}`,
      158,
      17,
    )
    expect(composerOf(terminal, "ragu")).toBe("ready")
    expect(screenQuestion(terminal, "ragu")).toBeUndefined()
    expect(mayGo(terminal)).toBe(true)
  })

  test("a line in the box that quotes it is a line", async () => {
    const terminal = await drawn(`${under}\x1b[10;6HY/N or ←→ to switch, enter to confirm`, 158, 17)
    expect(composerOf(terminal, "ragu")).toBe("draft")
    expect(screenQuestion(terminal, "ragu")).toBeUndefined()
  })
})

describe("the cursor says a dialog where the reading of menus misses one (re-review R4)", () => {
  const MISSED: [string, string, number, { cols: number; rows: number } | undefined, string][] = [
    ["claude-piano", "claude-code", 82_796, undefined, "Yes, and switch"],
    ["opencode-stretta-lunga", "opencode", 13_782, { cols: 102, rows: 43 }, "enter submit"],
    ["opencode-stretta-lunga", "opencode", 179_997, { cols: 102, rows: 43 }, "esc dismiss"],
  ]

  for (const [name, agent, moment, size, words] of MISSED) {
    test(`${agent} at +${moment}: «${words}», no box, no menu read, and the cursor says so`, async () => {
      let seen = 0
      await play(
        name,
        (terminal, at) => {
          if (at !== moment) return
          seen++
          expect(screenText(terminal)).toContain(words)
          expect(composerOf(terminal, agent)).toBe("none")
          expect(screenQuestion(terminal, agent)).toBeUndefined()
          expect(cursorSaysDialog(terminal, agent)).toBe(true)
        },
        size,
      )
      expect(seen).toBe(1)
    })
  }

  test("a box at rest never says it, on any agent's real bytes", async () => {
    for (const [name, agent] of [
      ["claude-piano", "claude-code"],
      ["claude-fiducia-si", "claude-code"],
      ["agy-invio-nel-box", "agy"],
      ["ragu-avvio-normale", "ragu"],
      ["opencode-stretta-lunga", "opencode"],
    ] as const) {
      let frames = 0
      await play(name, (terminal) => {
        if (composerOf(terminal, agent) !== "ready") return
        frames++
        expect(`${name}:${cursorSaysDialog(terminal, agent)}`).toBe(`${name}:false`)
      })
      expect(`${name}:${frames > 0}`).toBe(`${name}:true`)
    }
  })

  test("Claude Code without its flag: hidden in the box is at rest, hidden in the last column is a dialog", async () => {
    const RULE = "─".repeat(78)
    const atRest = await drawn(`\x1b[?25l${rowsAt([RULE, "❯ ", RULE], [2, 1])}`)
    expect(cursorSaysDialog(atRest, "claude-code")).toBe(false)
    const parked = await drawn(`\x1b[?25l${rowsAt([" ❯ 1. Yes", "   2. No"], [79, 11])}`)
    expect(cursorSaysDialog(parked, "claude-code")).toBe(true)
    expect(cursorSaysDialog(await drawn(rowsAt([" ❯ 1. Yes"], [79, 11])), "claude-code")).toBe(false)
  })

  test("the others: hidden is all it takes", async () => {
    const hidden = await drawn("\x1b[?25l")
    for (const agent of ["agy", "ragu", "opencode"]) expect(cursorSaysDialog(hidden, agent)).toBe(true)
    const shown = await drawn("")
    for (const agent of ["agy", "ragu", "opencode"]) expect(cursorSaysDialog(shown, agent)).toBe(false)
  })
})

describe("the gate and what it does not touch", () => {
  test("an agent ADE does not know stays on the reading of menus", () => {
    const terminal = new Terminal({ cols: 80, rows: 5, allowProposedApi: true })
    expect(composerOf(terminal, "goose")).toBeUndefined()
    expect(composerOf(terminal, "codex")).toBeUndefined()
    expect(mayTypeNow({ composer: undefined, question: false, nothingDrawn: false })).toBe(true)
    expect(mayTypeNow({ composer: undefined, question: true, nothingDrawn: false })).toBe(false)
    expect(lineBegunNow(undefined, true)).toBe(true)
    expect(questionHolds(undefined, true)).toBe(true)
  })

  test("an empty box says no question holds, over the words of a menu in a reply", () => {
    expect(questionHolds("ready", true)).toBe(false)
    expect(questionHolds("none", true)).toBe(true)
    expect(mayTypeNow({ composer: "ready", question: true, nothingDrawn: false })).toBe(true)
  })

  test("«Consegna ora» passes the box and not a menu", () => {
    expect(mayTypeNow({ composer: "none", question: false, nothingDrawn: false, armed: true })).toBe(true)
    expect(mayTypeNow({ composer: "none", question: true, nothingDrawn: false, armed: true })).toBe(false)
    expect(mayTypeNow({ composer: "none", question: false, nothingDrawn: false })).toBe(false)
  })

  const workbench = codeOf(readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8"))
  const between = (from: string, to: string) => {
    const start = workbench.indexOf(from)
    expect(start).toBeGreaterThan(0)
    return workbench.slice(start, workbench.indexOf(to, start))
  }

  test("lint: the box is never read per chunk", () => {
    const body = between("constfeedTerminal=", "screenRequests.fed(paneId)")
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toContain("composerNow")
    expect(body).not.toContain("composerOf")
  })

  test("lint: the pane's state goes on reading menus, and only the gate reads the box", () => {
    const body = between("constreadScreenStatus=", "onCleanup(")
    expect(body).toContain("screenAsks(paneId)")
    expect(body).not.toContain("composerNow")
  })

  test("lint: every line asks the gate before its text", () => {
    const body = between("consttypeLineNow=", "constESC=")
    expect(body).toContain("!mayType(paneId)")
    expect(body).toContain("textInBox(")
  })

  test("lint: a session that closes with its task unsent says so, in the pane and to the sender", () => {
    const poll = between("if(starting.typesTask){", "openingPolls.add(poll)")
    const gone = poll.slice(poll.indexOf("if(running.get(paneId)!==session){"), poll.indexOf("constdrawn=screenDrawn"))
    expect(gone).toContain('tellPane(paneId,t(trustSeen?"task.exitedOnTrust":"task.exitedUnsent"))')
    expect(gone).toContain("tellSender(asked.from,formatExitedUnsent(asked.id,reader,trustSeen))")
  })

  test("the sender hears why, in words that do not read as being ignored", () => {
    const reader = { id: "p", title: "agy 1" } as never
    expect(formatExitedUnsent("r1", reader, true)).toContain("No, exit")
    expect(formatExitedUnsent("r1", reader, false)).not.toContain("No, exit")
    expect(formatHeldByScreen("agy", reader)).toContain("non riconosce lo schermo di agy")
    expect(formatEnterStuck("r1", reader)).toContain("non ha premuto Invio")
  })

  test("lint: a remote session's agent command goes into the shell, and its task into the box", () => {
    expect(workbench).toContain("voidtypeLine(session,text,{intoShell,mail:!intoShell})")
    expect(between("conststartRemoteProcess=", "constaddRemoteSpace=")).toContain("composerNow(paneId)")
  })

  test("lint: a terminal has its cursor followed from its birth", () => {
    const registry = codeOf(readFileSync(new URL("../terminal/registry.ts", import.meta.url), "utf8"))
    expect(registry).toContain("watchCursor(terminal)")
  })
})
