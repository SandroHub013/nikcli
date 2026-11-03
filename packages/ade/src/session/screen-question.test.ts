import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Terminal } from "@xterm/xterm"
import { createLineAccumulator } from "../host/line-stream"
import { codeOf } from "../test-support/source-text"
import { detectPermission } from "./permission"
import { bottomRows, folderTrust, openingTrust, screenQuestion } from "./screen-question"

/*
 * Audit 2026-11-02, SES-3. Codex (ratatui) and OpenCode/ragu (opentui) place every row with `CSI row;col H` and write
 * no newline. The line stream gets the whole menu as one run-together line, so `detectPermission` never saw it, the
 * pane was quiet and free, and a delivery's Enter answered «Yes, proceed». The rows below are drawn the way those
 * programs draw them, into a real terminal, and read back the way the pane reads them.
 */

const COLS = 100
const ROWS = 24

function write(terminal: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve))
}

/** `rows` drawn as a cursor-addressed TUI draws them: a move to each row, styled text, no newline anywhere. */
function drawn(rows: readonly string[], top = ROWS - rows.length + 1): string {
  return (
    "\x1b[?25l" +
    rows.map((row, index) => `\x1b[${top + index};1H\x1b[2K\x1b[38;5;250m${row}\x1b[0m`).join("") +
    `\x1b[${ROWS};1H`
  )
}

async function screenOf(rows: readonly string[]): Promise<Terminal> {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  await write(terminal, drawn(rows))
  return terminal
}

/** What the line stream makes of the same bytes. */
function streamOf(rows: readonly string[]): string[] {
  const lines = createLineAccumulator()
  return [...lines.push(drawn(rows)), ...lines.flush()]
}

// codex 0.15x, exec approval: the composer is replaced by the modal, its hint at the bottom.
const CODEX_APPROVAL = [
  "• I'll run the test suite to check the change.",
  "",
  "  Would you like to run the following command?",
  "",
  "  Reason: run the project's tests",
  "",
  "  $ bun test --conditions=browser",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for this command (a)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
]

// OpenCode 1.x, and ragu without ADE's plugin: the prompt replaced by opentui's permission box, left-bordered.
const OPENCODE_PERMISSION = [
  "┃  △ Permission required",
  "┃",
  "┃    # Runs the test suite",
  "┃    $ bun test",
  "┃",
  "",
  "   Allow once   Allow always   Reject                                ⇆ select  enter confirm",
  "",
]

// Claude Code 2.1, at start-up, before its hooks are loaded: the folder-trust dialog.
const CLAUDE_TRUST = [
  "────────────────────────────────────────────────────────────────────────────────",
  " Accessing workspace:",
  "",
  " C:\\Users\\dev\\project",
  "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known",
  " open source project, or work from your team). If not, take a moment to review what's in this folder first.",
  "",
  " Claude Code'll be able to read, edit, and execute files here.",
  "",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
  "",
  " Enter to confirm · Esc to cancel",
]

// codex at start-up in an untrusted folder.
const CODEX_TRUST = [
  "> You are running Codex in C:\\Users\\dev\\project",
  "",
  "  Since this folder is version controlled, you may wish to allow Codex to work in this folder without",
  "  asking for approval.",
  "",
  "› 1. Yes, allow Codex to work in this folder without asking for approval",
  "  2. No, ask me to approve edits and commands",
  "",
  "  Press enter to continue",
]

// The 10-29 case (fc42de7d9), as Claude Code shows it: a reply ending with numbered sentences, then the prompt.
const REPLY_WITH_LIST = [
  "● Is the plan clear?",
  "  1. Now: Codex Study reads their notes and maps every stage of the work.",
  "  2. Only if stage 1 finds a cheap design do we open the second one.",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  "> ",
  "────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
]

// codex at rest: its composer and footer.
const CODEX_IDLE = [
  "• Done: the tests pass.",
  "",
  "› Ask Codex to do anything",
  "",
  "  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit",
]

describe("a menu drawn with the cursor is read off the screen", () => {
  test("codex's approval modal: missed by the line stream, found on the screen", async () => {
    expect(detectPermission(streamOf(CODEX_APPROVAL), "codex")).toBeUndefined()

    const asked = screenQuestion(await screenOf(CODEX_APPROVAL), "codex")
    expect(asked?.what).toBe("Would you like to run the following command?")
    expect(asked?.answers.map((answer) => answer.label)).toEqual([
      "Yes, proceed (y)",
      "Yes, and don't ask again for this command (a)",
      "No, and tell Codex what to do differently (esc)",
    ])
  })

  test("OpenCode's permission prompt: its choices on one row", async () => {
    expect(detectPermission(streamOf(OPENCODE_PERMISSION), "opencode")).toBeUndefined()

    const asked = screenQuestion(await screenOf(OPENCODE_PERMISSION), "opencode")
    expect(asked?.what).toBe("Permission required")
    expect(asked?.answers.map((answer) => answer.label)).toEqual(["Allow once", "Allow always", "Reject"])
  })

  test("a folder-trust dialog, Claude Code's and codex's", async () => {
    expect(detectPermission(streamOf(CLAUDE_TRUST), "claude-code")).toBeUndefined()
    expect(screenQuestion(await screenOf(CLAUDE_TRUST), "claude-code")?.answers.map((answer) => answer.label)).toEqual([
      "Yes, I trust this folder",
      "No, exit",
    ])
    expect(screenQuestion(await screenOf(CODEX_TRUST), "codex")?.answers).toHaveLength(2)
  })

  test("a long option wrapped on a narrow screen is still one option", () => {
    const rows = [
      "  Would you like to make the following edits?",
      "",
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again for these files",
      "     (a)",
      "  3. No, and tell Codex what to do differently",
      "     (esc)",
      "",
      "  Press enter to confirm or esc to cancel",
    ]
    expect(detectPermission(rows, "codex", { screen: true })?.answers.map((answer) => answer.send)).toEqual([
      "1",
      "2",
      "3",
    ])
  })

  test("the bottom of the buffer is read, not a view the user scrolled back", async () => {
    const terminal = await screenOf(CODEX_APPROVAL)
    await write(terminal, "\r\n".repeat(ROWS) + drawn(CODEX_APPROVAL))
    terminal.scrollToTop()
    expect(bottomRows(terminal).join("\n")).toContain("Press enter to confirm or esc to cancel")
    expect(screenQuestion(terminal, "codex")).toBeDefined()
  })
})

describe("the workbench", () => {
  const source = codeOf(readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8"))

  test("weighs the screen wherever it asks whether a question is open", () => {
    expect(source).toContain(
      codeOf(
        "const questionOpen = (paneId: string) => isQuestionOpen(permissions()[paneId], activityOf.get(paneId)) || modeTracker.heldOpen(paneId) || screenAsks(paneId)",
      ),
    )
    expect(source).toContain(codeOf("menuHold.waiting(paneId, getTerminal(paneId).terminal, pane.agent ?? pane.model)"))
  })

  test("does not take a pane whose screen it cannot read as free", () => {
    expect(source).toContain(codeOf("screenUnread: !hasTerminal(paneId) || unparsed.behind(paneId),"))
  })
})

describe("what is not a menu stays not one", () => {
  test("the 10-29 reply: numbered sentences under a question, on the screen", async () => {
    expect(screenQuestion(await screenOf(REPLY_WITH_LIST), "claude-code")).toBeUndefined()
    // And the same rows at the very bottom, with nothing under them.
    expect(detectPermission(REPLY_WITH_LIST.slice(0, 3), "claude-code", { screen: true })).toBeUndefined()
  })

  test("numbered sentences with a hint-like line under them, but no cursor and no answers", () => {
    const rows = ["Here is what I did?", "1. Read the notes", "2. Mapped the stages", "", "Press enter to continue"]
    expect(detectPermission(rows, "codex", { screen: true })).toBeUndefined()
  })

  test("codex at rest", async () => {
    expect(screenQuestion(await screenOf(CODEX_IDLE), "codex")).toBeUndefined()
  })

  test("the screen's menus are never read from the line stream", () => {
    expect(detectPermission(CODEX_APPROVAL, "codex")).toBeUndefined()
    expect(detectPermission(OPENCODE_PERMISSION, "opencode")).toBeUndefined()
  })
})

/*
 * Review of invio-giusto, point 3: since SES-3 an opening task waits behind a folder-trust dialog, and a session
 * spawned with --worktree sat there until a click came, then gave its task up after a minute.
 */
describe("a folder-trust dialog in front of the opening task", () => {
  test("is told apart from any other question, with its yes selected", async () => {
    expect(folderTrust(bottomRows(await screenOf(CLAUDE_TRUST)), "claude-code")).toEqual({ yesSelected: true })
    expect(folderTrust(bottomRows(await screenOf(CODEX_TRUST)), "codex")).toEqual({ yesSelected: true })
    expect(folderTrust(bottomRows(await screenOf(CODEX_APPROVAL)), "codex")).toBeUndefined()
    expect(folderTrust(bottomRows(await screenOf(CODEX_IDLE)), "codex")).toBeUndefined()
  })

  test("with the cursor moved to «No», its yes is not selected", async () => {
    const moved = CLAUDE_TRUST.map((row) =>
      row === " ❯ 1. Yes, I trust this folder"
        ? "   1. Yes, I trust this folder"
        : row === "   2. No, exit"
          ? " ❯ 2. No, exit"
          : row,
    )
    expect(folderTrust(bottomRows(await screenOf(moved)), "claude-code")).toEqual({ yesSelected: false })
  })

  test("is confirmed only in a worktree ADE made for the spawn, and only on its yes", () => {
    expect(openingTrust({ yesSelected: true }, true)).toBe("accept")
    expect(openingTrust({ yesSelected: true }, false)).toBe("ask")
    expect(openingTrust({ yesSelected: false }, true)).toBe("ask")
  })

  test("the opening poll confirms it with one Enter there, and says to confirm it everywhere else", () => {
    const source = codeOf(readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8"))
    const poll = source.slice(source.indexOf(codeOf("if (starting.typesTask) {")))
    const tick = poll.slice(0, poll.indexOf(codeOf("const decision = decideOpening({")))
    expect(tick).toContain(
      codeOf("const ownWorktree = launched?.worktree !== undefined && sameFolder(workDir, launched.worktree)"),
    )
    expect(tick).toContain(codeOf("folderTrust(bottomRows(getTerminal(paneId).terminal), agentId)"))
    expect(tick).toContain(
      codeOf(
        'if (openingTrust(trust, ownWorktree) === "accept") { session.write("\\r") appendLine(paneId, t("task.trustAccepted"), "note", "ade") } else tellPane(paneId, t("task.confirmTrust"))',
      ),
    )
  })
})
