import { describe, expect, test } from "bun:test"
import {
  answerLabel,
  classifyAnswer,
  detectPermission,
  followPermission,
  isResolved,
  permissionIdentity,
  permissionSpeechLabel,
  type PermissionAnswer,
  type PermissionRequest,
} from "./permission"

/** What a button shows, with the interface in Italian: the label, the keystroke and the tone. */
const view = (answers: readonly PermissionAnswer[], language: "it" | "en" = "it") =>
  answers.map((a) => ({ label: answerLabel(a, language), send: a.send, tone: a.tone }))

describe("permissionSpeechLabel", () => {
  test("names only the safe request type in either locale", () => {
    expect(permissionSpeechLabel("shell", "it")).toBe("un comando")
    expect(permissionSpeechLabel("write", "it")).toBe("una modifica ai file")
    expect(permissionSpeechLabel("network", "it")).toBe("una richiesta di rete")
    expect(permissionSpeechLabel("unknown", "it")).toBe("un'azione generica")
    expect(permissionSpeechLabel("shell", "en")).toBe("a command")
    expect(permissionSpeechLabel("write", "en")).toBe("a file change")
    expect(permissionSpeechLabel("network", "en")).toBe("a network request")
    expect(permissionSpeechLabel("unknown", "en")).toBe("a generic action")
    expect(permissionSpeechLabel(undefined, "it")).toBe("un'azione generica")
    expect(permissionSpeechLabel("rm -rf API_KEY_SECRET" as PermissionRequest["kind"], "it")).toBe("un'azione generica")
  })
})

// Full review 2026-10-06, sessions 13: the button's text is in the interface's language, and what an answer does is a field.
describe("the answers of a prompt: intent and shown label", () => {
  const menu = ["Do you want to run this command?", "  1. Yes", "  2. Yes, and don't ask again", "  3. No"]

  test("each choice carries what it does, read once where the prompt is read", () => {
    const req = detectPermission(menu, "claude-code")!
    expect(req.answers.map((a) => a.intent)).toEqual(["yes", "always", "no"])
    const edits = detectPermission(
      ["Do you want to make this edit?", "  1. Yes", "  2. Yes, allow all edits during this session", "  3. No"],
      "claude-code",
    )!
    expect(edits.answers.map((a) => a.intent)).toEqual(["yes", "always", "no"])
    const menuTwo = detectPermission(
      ["Allow this?", "  1. Allow always", "  2. Allow once", "  3. Deny"],
      "claude-code",
    )!
    expect(menuTwo.answers.map((a) => a.intent)).toEqual(["always", "once", "no"])
  })

  test("with the interface in English the buttons are in English, in Italian they are in Italian", () => {
    const req = detectPermission(menu, "claude-code")!
    expect(view(req.answers, "en").map((a) => a.label)).toEqual(["Yes", "Yes, and don't ask again", "No"])
    expect(view(req.answers, "it").map((a) => a.label)).toEqual(["Sì", "Sì, e non chiedere più", "No"])
    // The CLI's own longer wording is shown as it wrote it, in either language.
    const edits = detectPermission(
      ["Do you want to make this edit?", "  1. Yes", "  2. Yes, allow all edits during this session", "  3. No"],
      "claude-code",
    )!
    expect(view(edits.answers, "en")[1]!.label).toBe("Yes, allow all edits during this session")
    expect(view(edits.answers, "it")[1]!.label).toBe("Yes, allow all edits during this session")
  })

  test("ADE's own prompts (the [y/N] one and the plain question) are shown in the interface's language too", () => {
    const yn = detectPermission(["Run the tests? [y/N/a]"], "x")!
    expect(yn.answers.map((a) => a.intent)).toEqual(["yes", "no", "always"])
    expect(view(yn.answers, "en").map((a) => a.label)).toEqual(["Yes", "No", "Always"])
    expect(view(yn.answers, "it").map((a) => a.label)).toEqual(["Sì", "No", "Sempre"])
    const plain = detectPermission(["Do you want to proceed?"], "x")
    if (plain) {
      expect(view(plain.answers, "en").map((a) => a.label)).toEqual(["Allow", "Deny"])
      expect(view(plain.answers, "it").map((a) => a.label)).toEqual(["Consenti", "Nega"])
    }
  })

  // F7e, D1: the wordings of the installed CLIs that grant more than the request on screen. Each one starts with «yes».
  test("classifyAnswer reads every answer that grants more than the request as always", () => {
    const wider = [
      "Yes, and remember this directory",
      "Yes, and keep allowing any reads outside the working directories",
      "Yes, and use auto mode",
      "Yes, auto-accept edits",
      "Yes, clear context and auto-accept edits",
      "Yes, clear context and bypass permissions",
      "Yes, clear context and use auto mode",
      "Yes, and allow this host in the future",
    ]
    for (const label of wider) expect([label, classifyAnswer(label)]).toEqual([label, "always"])
    // The one the plan menu offers that grants only the plan.
    expect(classifyAnswer("Yes, manually approve edits")).toBe("yes")
  })

  // F7e, D2: the plain yes wordings a CLI may use, for recognising a label (not for what a spoken yes may send).
  test("classifyAnswer reads ok, continue, run, esegui, approva, permetti and autorizza as a yes", () => {
    for (const label of ["Ok", "Okay", "Continue", "Continua", "Run", "Esegui", "Approva", "Permetti", "Autorizza"]) {
      expect([label, classifyAnswer(label)]).toEqual([label, "yes"])
    }
    for (const label of ["Not now", "Running late", "Okapi", "Continuous"]) {
      expect([label, classifyAnswer(label)]).toEqual([label, "other"])
    }
  })

  test("classifyAnswer reads the CLI's wordings in both languages", () => {
    const table: [string, string][] = [
      ["Yes", "yes"],
      ["Sì", "yes"],
      ["Allow", "yes"],
      ["Allow once", "once"],
      ["Yes, only this time", "once"],
      ["Always allow", "always"],
      ["Sì, e non chiedere più", "always"],
      ["Yes, and don't ask again for npm commands", "always"],
      ["Yes, allow all edits during this session", "always"],
      ["No", "no"],
      ["No, and tell Claude what to do differently", "no"],
      ["Deny", "no"],
      ["Rifiuta", "no"],
      ["Cancel", "cancel"],
      ["Annulla", "cancel"],
      ["Skip", "skip"],
      ["Show me the diff", "other"],
      ["Nothing", "other"],
    ]
    for (const [label, intent] of table) expect([label, classifyAnswer(label)]).toEqual([label, intent])
  })
})

describe("detectPermission - Numbered Choices", () => {
  test("detects standard 3-choice permission prompt", () => {
    const lines = ["Do you want to run this command?", "  1. Yes", "  2. Yes, and don't ask again", "  3. No"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.what).toBe("Do you want to run this command?")
    expect(req!.answers.length).toBe(3)

    expect(view([req!.answers[0]!])[0]).toEqual({
      label: "Sì",
      send: "1",
      tone: "primary",
    })
    expect(view([req!.answers[1]!])[0]).toEqual({
      label: "Sì, e non chiedere più",
      send: "2",
      tone: "secondary",
    })
    expect(view([req!.answers[2]!])[0]).toEqual({
      label: "No",
      send: "3",
      tone: "secondary",
    })
  })

  test("a menu with a cursor on the selected option is still a menu (review area 2)", () => {
    // What Claude Code and codex draw: without this, no request was seen, and
    // after the quiet a delivery's Enter confirmed the selected option.
    const req = detectPermission(["Do you want to proceed?", "❯ 1. Yes", "  2. No"], "codex")
    expect(req?.what).toBe("Do you want to proceed?")
    expect(req?.answers.map((a) => a.send)).toEqual(["1", "2"])
  })

  test("a menu drawn inside a box is read through its frame", () => {
    const lines = [
      "╭──────────────────────────────────────────╮",
      "│ Do you want to make this edit to a.ts?   │",
      "│ › 1. Yes                                 │",
      "│   2. Yes, allow all edits                │",
      "│   3. No                                  │",
      "│                                          │",
      "╰──────────────────────────────────────────╯",
    ]
    const req = detectPermission(lines, "agy")
    expect(req?.what).toBe("Do you want to make this edit to a.ts?")
    expect(req?.answers.map((a) => a.send)).toEqual(["1", "2", "3"])
  })

  test("detects shell command context with numbered choices and trailing prompt", () => {
    const lines = [
      "$ rm -rf dist/",
      "Execute this command?",
      "  1) Allow once",
      "  2) Allow always",
      "  3) Deny",
      "Select an option [1-3]:",
    ]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.what).toBe("Execute this command?")
    expect(req!.kind).toBe("shell")
    expect(req!.target).toBe("rm -rf dist/")
    expect(view(req!.answers)).toEqual([
      { label: "Consenti una volta", send: "1", tone: "primary" },
      { label: "Sì, e non chiedere più", send: "2", tone: "secondary" },
      { label: "No", send: "3", tone: "secondary" },
    ])
  })

  test("detects file write target with bracketed choices", () => {
    const lines = [
      "The agent wants to write to packages/ade/src/session/stream.ts",
      "Confirm action?",
      "  [1] Approve",
      "  [2] Reject",
    ]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.kind).toBe("write")
    expect(req!.target).toBe("packages/ade/src/session/stream.ts")
    expect(view(req!.answers)).toEqual([
      { label: "Sì", send: "1", tone: "primary" },
      { label: "No", send: "2", tone: "secondary" },
    ])
  })
})

describe("detectPermission - [y/N] and (y/n) prompts", () => {
  test("detects [y/N] with default No (primary tone on No)", () => {
    const lines = ["Allow execution of `git reset --hard HEAD~1`? [y/N]"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.what).toBe("Allow execution of `git reset --hard HEAD~1`? [y/N]")
    expect(req!.kind).toBe("shell")
    expect(req!.target).toBe("git reset --hard HEAD~1")
    expect(view(req!.answers)).toEqual([
      { label: "Sì", send: "y", tone: "secondary" },
      { label: "No", send: "n", tone: "primary" },
    ])
  })

  test("detects [Y/n] with default Yes (primary tone on Yes)", () => {
    const lines = ["Apply changes to packages/ade/src/session/permission.ts? [Y/n]"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.kind).toBe("write")
    expect(req!.target).toBe("packages/ade/src/session/permission.ts")
    expect(view(req!.answers)).toEqual([
      { label: "Sì", send: "y", tone: "primary" },
      { label: "No", send: "n", tone: "secondary" },
    ])
  })

  test("detects network request URL in (y/n) prompt", () => {
    const lines = ["Allow network connection to https://api.github.com/repos? (y/n)"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.kind).toBe("network")
    expect(req!.target).toBe("https://api.github.com/repos")
    expect(view(req!.answers)).toEqual([
      { label: "Sì", send: "y", tone: "primary" },
      { label: "No", send: "n", tone: "secondary" },
    ])
  })

  test("detects 3-way prompt with always option [y/N/a]", () => {
    const lines = ["Run shell command: npm install? [y/N/a]"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.kind).toBe("shell")
    expect(req!.target).toBe("npm install")
    expect(view(req!.answers)).toEqual([
      { label: "Sì", send: "y", tone: "secondary" },
      { label: "No", send: "n", tone: "primary" },
      { label: "Sempre", send: "a", tone: "secondary" },
    ])
  })

  test("handles prompt with trailing cursor on separate line", () => {
    const lines = ["Do you want to proceed? [y/N]", ">"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.what).toBe("Do you want to proceed? [y/N]")
    expect(req!.answers[0].send).toBe("y")
    expect(req!.answers[1].send).toBe("n")
  })
})

describe("detectPermission - Simple Question with Prompt", () => {
  test("detects question preceded by $ shell command", () => {
    const lines = ["$ git push origin main", "Run this shell command?", ">"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.what).toBe("Run this shell command?")
    expect(req!.kind).toBe("shell")
    expect(req!.target).toBe("git push origin main")
    expect(view(req!.answers)).toEqual([
      { label: "Consenti", send: "y", tone: "primary" },
      { label: "Nega", send: "n", tone: "secondary" },
    ])
  })

  test("detects file write question", () => {
    const lines = ["Modifying file packages/ade/package.json", "Allow file modification?"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.kind).toBe("write")
    expect(req!.target).toBe("packages/ade/package.json")
    expect(view(req!.answers)).toEqual([
      { label: "Consenti", send: "y", tone: "primary" },
      { label: "Nega", send: "n", tone: "secondary" },
    ])
  })
})

describe("detectPermission - False Positives (must return undefined)", () => {
  test("diff line addition with ternary operator containing ?", () => {
    const lines = [
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -15,3 +15,4 @@",
      "+ const isReady = state === 'done' ? true : false;",
    ]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("diff line with optional chaining containing ?", () => {
    const lines = ["- return session?.agent?.status;"]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("test runner passing output with question in test title", () => {
    const lines = [
      "bun test v1.4.0",
      "✓ detectPermission > handles ? in prompts (2ms)",
      "PASS packages/ade/src/session/stream.test.ts (1.2s)",
      "Tests: 552 passed, 552 total",
    ]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("rhetorical question inside agent reasoning/thinking", () => {
    const lines = ["Thinking: Why did this compilation step fail? Let me inspect the error log."]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("progress bar with percentage and download rate", () => {
    const lines = ["[===================>       ] 75% 4.5MB/s ETA: 2s"]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("action plan numbered list describing upcoming steps", () => {
    const lines = [
      "Steps to complete the task:",
      "  1. First create the module file",
      "  2. Next write the accompanying unit tests",
      "  3. Finally verify with bun test",
    ]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("stack trace line with error location", () => {
    const lines = ["Error: file not found", "    at Object.readFile (fs.ts:120:15)"]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("empty lines or whitespace-only buffer", () => {
    expect(detectPermission([], "test-agent")).toBeUndefined()
    expect(detectPermission(["", "   ", "\n"], "test-agent")).toBeUndefined()
  })
})

describe("detectPermission - ANSI handling", () => {
  test("strips ANSI decorations from question and options", () => {
    const lines = [
      "\x1b[1m\x1b[33mDo you want to run this command?\x1b[0m",
      "  \x1b[32m1.\x1b[0m Yes",
      "  \x1b[31m2.\x1b[0m No",
    ]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.what).toBe("Do you want to run this command?")
    expect(req!.answers.length).toBe(2)
    expect(req!.answers[0].send).toBe("1")
    expect(req!.answers[1].send).toBe("2")
  })
})

describe("isResolved", () => {
  const dummyRequest: PermissionRequest = {
    what: "Do you want to run this command? [y/N]",
    kind: "shell",
    target: "git status",
    answers: [
      { intent: "yes", label: "Yes", send: "y", tone: "secondary" },
      { intent: "no", label: "No", send: "n", tone: "primary" },
    ],
  }

  const resolved = (lines: string[]) => isResolved(dummyRequest, lines, "claude-code")

  test("returns false when newLines is empty", () => {
    expect(resolved([])).toBe(false)
  })

  test("returns false when newLines contains only empty strings or whitespace", () => {
    expect(resolved(["", "   ", "\n"])).toBe(false)
  })

  test("returns false when newLines only echoes the prompt or question", () => {
    expect(resolved(["Do you want to run this command? [y/N]"])).toBe(false)
    expect(resolved([">"])).toBe(false)
    expect(resolved([":"])).toBe(false)
  })

  test("returns true when newLines contains actual process output", () => {
    const newLines = ["Running command...", "$ git status", "On branch main"]
    expect(resolved(newLines)).toBe(true)
  })

  test("returns true when newLines contains user response or error", () => {
    expect(resolved(["Action denied by user."])).toBe(true)
    expect(resolved(["1"])).toBe(true)
    expect(resolved(["y"])).toBe(true)
  })

  /*
   * The agents that ask these questions draw them with Ink or ratatui, which
   * repaint the whole frame several times a second while they wait. Every
   * repaint is new output, and "new output" used to mean "answered": the first
   * frame after a question was detected cleared the request and set the pane
   * back to "In esecuzione" while the agent was still waiting for a keystroke.
   */
  describe("a redrawn frame is not an answer", () => {
    test("the question repainted among other lines is still the question", () => {
      const frame = ["  Esecuzione comando", "  $ git status", "Do you want to run this command? [y/N]"]
      expect(resolved(frame)).toBe(false)
    })

    test("a spinner drawn under the question does not resolve it", () => {
      expect(resolved(["Do you want to run this command? [y/N]", ""])).toBe(false)
    })

    test("the question gone means answered", () => {
      expect(resolved(["On branch main", "nothing to commit"])).toBe(true)
    })

    test("a different question means the old one is done", () => {
      // Resolved from this request's point of view; the next read picks the
      // new one up as a request of its own.
      expect(resolved(["Vuoi sovrascrivere src/app.ts? [y/N]"])).toBe(true)
    })
  })
})

/*
 * Verifiche, medi-restyle: a three-option menu showed two buttons and no «No».
 * The window grows a line at a time, the question is found at «2.», and the
 * pending request was then only checked for an answer, never read again.
 */
describe("followPermission", () => {
  const menu = ["Do you want to run this command?", "  1. Yes", "  2. Yes, and don't ask again", "  3. No"]

  test("a menu read a line at a time keeps the answers that come after it was found", () => {
    const window: string[] = []
    let pending: PermissionRequest | undefined
    let foundAt = -1
    for (const [index, line] of menu.entries()) {
      window.push(line)
      if (pending) pending = followPermission(pending, window, "claude-code")
      else if ((pending = detectPermission(window, "claude-code"))) foundAt = index
    }
    expect(foundAt).toBeLessThan(menu.length - 1)
    expect(pending?.answers.map((answer) => answer.send)).toEqual(["1", "2", "3"])
    expect(pending?.answers.at(-1)?.label).toBe("No")
  })

  test("the same request while the menu is redrawn, none once the agent moved on", () => {
    const request = detectPermission(menu, "claude-code")!
    expect(followPermission(request, [...menu, ...menu], "claude-code")).toBe(request)
    expect(followPermission(request, ["Running the command…", "done"], "claude-code")).toBeUndefined()
  })
})

test("lint: the pane follows a pending request with followPermission", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(import.meta.dir, "../surface/workbench.tsx"),
    "utf8",
  )
  expect(source).toContain("const still = followPermission(pending, recent, agent)")
})

// Full review 2026-10-06, ui 4: the voice and the alerts are handed the request's identity, not its heading alone.
test("a request is told by its heading and its target, and the workbench hands that to the voice and the alerts", () => {
  expect(permissionIdentity({ what: "Do you want to proceed?", target: "rm -rf ~" })).not.toBe(
    permissionIdentity({ what: "Do you want to proceed?", target: "cat README" }),
  )
  expect(permissionIdentity({ what: "run command" })).toBe("run command")
  const source = require("node:fs").readFileSync(
    require("node:path").join(import.meta.dir, "../surface/workbench.tsx"),
    "utf8",
  )
  expect(source).toContain("handlePermissionRequest(paneId, permissionIdentity(request)")
  expect(source).toContain("permissionIdentity(request), request.kind)")
  expect(source).not.toContain("handlePermissionRequest(paneId, request.what")
})
