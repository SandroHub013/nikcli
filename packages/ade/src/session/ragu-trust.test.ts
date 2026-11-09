import { describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/xterm"
import { writtenTo } from "../test-support/live-bytes"
import { composerOf, cursorSaysDialog, mayTypeNow, watchCursor } from "./composer"
import { createDeliverNow } from "./deliver-now"
import { typeThenEnter } from "./enter"
import { bottomRows, folderTrust, screenQuestion } from "./screen-question"

/*
 * ragu 0.2.17b asks «Trust project» before its TUI, with `@clack/prompts`' confirm. `y` and `n` answer at once, `h j k l` turn
 * the answer round, and a bare Enter says No, so a task typed there is the answer: «You are ...» grants the trust.
 *
 * SYNTHETIC BYTES: what the real clack 1.0.0-alpha.1 renders for ragu's real message (`cli/bootstrap.ts`), written to memory
 * at each width, with the folder masked and each newline given the CR a terminal gets. The real ones are the live test's.
 */
const open = (bar: string, diamond: string) =>
  `\x1b[?25l\x1b[90m${bar}\x1b[39m\n\x1b[36m${diamond}\x1b[39m  Trust project C:\\work\\proj?\n`
const NO_SELECTED =
  "\x1b[36m│\x1b[39m  \x1b[2m○\x1b[22m \x1b[2mYes\x1b[22m \x1b[2m/\x1b[22m \x1b[32m●\x1b[39m No\n\x1b[36m└\x1b[39m\n"
const YES_SELECTED =
  "\x1b[36m│\x1b[39m  \x1b[32m●\x1b[39m Yes \x1b[2m/\x1b[22m \x1b[2m○\x1b[22m \x1b[2mNo\x1b[22m\n\x1b[36m└\x1b[39m\n"
const ASCII_NO_SELECTED =
  "\x1b[36m|\x1b[39m  \x1b[2m \x1b[22m \x1b[2mYes\x1b[22m \x1b[2m/\x1b[22m \x1b[32m>\x1b[39m No\n\x1b[36m—\x1b[39m\n"

const WIDE =
  "Config files: ragu.json; project folders: .ragu.\n" +
  "Plugins: none. MCP servers: none. Commands: none. Commands with shell execution: none. Project plugins and MCP servers can execute code with your user\n" +
  "permissions.\n"
const MIDDLE =
  "Config files: ragu.json; project folders: .ragu.\n" +
  "Plugins: none. MCP servers: none. Commands: none. Commands with shell\n" +
  "execution: none. Project plugins and MCP servers can execute code with your\n" +
  "user permissions.\n"
const NARROW =
  "Config files: ragu.json; project\nfolders: .ragu.\nPlugins: none. MCP servers: none.\nCommands: none. Commands with shell\n" +
  "execution: none. Project plugins and\nMCP servers can execute code with\nyour user permissions.\n"

const FRAMES: [string, number, number, string][] = [
  ["158x21", 158, 21, open("│", "◆") + WIDE + NO_SELECTED],
  ["the yes selected, after h", 158, 21, open("│", "◆") + WIDE + YES_SELECTED],
  ["76x13", 76, 13, open("│", "◆") + MIDDLE + NO_SELECTED],
  ["36x15", 36, 15, open("│", "◆") + NARROW + NO_SELECTED],
  ["76x6, the question scrolled off", 76, 6, open("│", "◆") + MIDDLE + NO_SELECTED],
  ["no Unicode", 76, 13, open("|", "*") + MIDDLE + ASCII_NO_SELECTED],
]

async function drawn(bytes: string, cols: number, rows: number) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true })
  watchCursor(terminal)
  await writtenTo(terminal, bytes.replace(/\n/g, "\r\n"))
  return terminal
}

const TASK = "You are reviewing this project: find the bug and say which file."

const facts = (terminal: Terminal, armed: boolean) => ({
  composer: composerOf(terminal, "ragu"),
  question: screenQuestion(terminal, "ragu") !== undefined,
  nothingDrawn: false,
  armed,
})

describe("ragu's «Trust project», before its TUI", () => {
  for (const [name, cols, rows, bytes] of FRAMES) {
    describe(name, () => {
      test("it is read as a question, with its y and its n", async () => {
        const menu = screenQuestion(await drawn(bytes, cols, rows), "ragu")
        expect(menu?.under).toBe(0)
        expect(menu?.answers.map((answer) => answer.send)).toEqual(["y", "n"])
      })

      test("nothing is typed there: no box, and not on the click of «Consegna ora» either", async () => {
        const terminal = await drawn(bytes, cols, rows)
        expect(composerOf(terminal, "ragu")).toBe("none")
        expect(mayTypeNow(facts(terminal, false))).toBe(false)
        expect(mayTypeNow(facts(terminal, true))).toBe(false)
      })

      test("a task starting with a y is not written, and neither is its Enter", async () => {
        const terminal = await drawn(bytes, cols, rows)
        const written: string[] = []
        const outcome = await typeThenEnter({
          text: TASK,
          write: (data) => void written.push(data),
          wait: async () => {},
          alive: () => true,
          permissionOpen: () => !mayTypeNow(facts(terminal, true)),
        })
        expect(outcome).toBe("not-typed")
        expect(written).toEqual([])
      })

      test("«Consegna ora» is never offered over it, not even after the five minutes of a dialog", async () => {
        const terminal = await drawn(bytes, cols, rows)
        const now = createDeliverNow()
        const { composer, question } = facts(terminal, false)
        const hold = { blind: composer !== "ready" && !question, dialog: cursorSaysDialog(terminal) }
        for (let at = 0; at <= 6 * 60_000; at += 1_000) expect(now.mailHeld("p", hold, at, "sender")).toBeUndefined()
        expect(now.offered("p")).toBe(false)
      })

      test("ADE does not answer it for a worktree of its own: it is no folder-trust dialog with an Enter", async () => {
        expect(folderTrust(bottomRows(await drawn(bytes, cols, rows)), "ragu")).toBeUndefined()
      })
    })
  }

  test("once answered it is gone: clack leaves the answer and no choice", async () => {
    const answered = `\x1b[90m│\x1b[39m\r\n\x1b[32m◇\x1b[39m  Trust project C:\\work\\proj?\r\n\x1b[90m│\x1b[39m  \x1b[2mNo\x1b[22m\r\n`
    expect(screenQuestion(await drawn(answered, 158, 21), "ragu")).toBeUndefined()
  })

  test("its two rows quoted in a reply, with ragu's box under them, hold nothing", async () => {
    const quoted = "\x1b[1;1H│  ○ Yes / ● No\x1b[2;1H└\x1b[9;3H┃\x1b[10;3H┃\x1b[11;3H┃  Build · Grok 4.7 · xAI\x1b[10;6H"
    const terminal = await drawn(quoted, 158, 17)
    expect(composerOf(terminal, "ragu")).toBe("ready")
    expect(screenQuestion(terminal, "ragu")).toBeUndefined()
    expect(mayTypeNow(facts(terminal, false))).toBe(true)
  })

  test("it is ragu's: other agents' screens are not read for it", async () => {
    const [, cols, rows, bytes] = FRAMES[0]!
    expect(screenQuestion(await drawn(bytes, cols, rows), "opencode")).toBeUndefined()
  })
})
