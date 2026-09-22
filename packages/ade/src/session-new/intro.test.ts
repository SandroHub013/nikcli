import { describe, expect, test } from "bun:test"
import { INTRO_TEXT, MODEL_LINES, displayArgs, introArgs, introText, withIntro } from "./intro"

describe("introArgs", () => {
  test("the CLIs with an instructions flag get the notice there", () => {
    expect(introArgs("claude-code")).toEqual(["--append-system-prompt", INTRO_TEXT])
    expect(introArgs("pi")[0]).toBe("--append-system-prompt")
    expect(introArgs("prime")[0]).toBe("--append-system-prompt")
    const codex = introArgs("codex")
    expect(codex[0]).toBe("-c")
    expect(codex[1]!.startsWith('developer_instructions="Sei una sessione')).toBe(true)
  })

  test("the rest get no arguments", () => {
    for (const id of ["agy", "opencode", "nikcli", "kimi", "hermes", "terminal"]) {
      expect([id, introArgs(id)]).toEqual([id, []])
    }
  })

  test("the text survives cmd.exe: none of its metacharacters", () => {
    expect(INTRO_TEXT).not.toMatch(/["&|<>^%]/)
    expect(INTRO_TEXT).toContain("ade-msg send")
  })
})

describe("introText", () => {
  test("one line more for a model ADE knows, the plain notice otherwise", () => {
    expect(introText("claude-code", "claude-opus-5")).toBe(`${INTRO_TEXT} ${MODEL_LINES[0]!.line}`)
    expect(introText("claude-code", "sonnet")).toContain("Riporta tutto")
    expect(introText("claude-code", "claude-fable-5-1")).toContain("elenchi e grassetto")
    expect(introText("claude-code", "claude-haiku-4-5-20251001")).toBe(INTRO_TEXT)
    expect(introText("claude-code", undefined)).toBe(INTRO_TEXT)
  })

  /** The review's reproduction: a Prime pane whose model is called like ours must not get Sonnet's line. */
  test("only claude-code gets a model line, whatever the model is called", () => {
    for (const id of ["prime", "pi", "codex", "agy", "opencode", "nikcli", "terminal"]) {
      expect([id, introText(id, "un-modello-con-sonnet-nel-nome")]).toEqual([id, INTRO_TEXT])
      expect(introArgs(id, introText(id, "opus"))).toEqual(introArgs(id))
    }
  })

  /** The notice tells everyone to delegate big tasks; the Opus line must cap that, not contradict it. */
  test("the Opus line caps delegation and does not forbid it", () => {
    expect(INTRO_TEXT).toContain("Delega compiti grandi, non piccoli")
    const opus = MODEL_LINES.find((entry) => entry.match.test("opus"))!.line
    expect(opus).not.toContain("non aprire sessioni")
    expect(opus).toContain("una sessione sola")
    expect(opus).toContain("mai per controllare il tuo")
  })

  test("every model line survives cmd.exe like the notice", () => {
    for (const { line } of MODEL_LINES) expect(line).not.toMatch(/["&|<>^%]/)
  })

  test("the transcript folds the notice and keeps the model's line", () => {
    const [, shown] = displayArgs(["--append-system-prompt", introText("claude-code", "opus")])
    expect(shown!.startsWith("…ade-msg… ")).toBe(true)
    expect(shown).toContain("una sessione sola")
  })
})

describe("withIntro", () => {
  test("a CLI without the flag gets it in front of its task", () => {
    expect(withIntro("agy", "sistema il bug", "NOTA")).toBe("(NOTA) sistema il bug")
  })

  test("no task, no notice typed; a CLI with the flag, the task untouched", () => {
    expect(withIntro("agy", "  ", "NOTA")).toBe("  ")
    expect(withIntro("claude-code", "sistema il bug", "NOTA")).toBe("sistema il bug")
  })
})

test("the transcript shows a mark instead of the whole notice", () => {
  expect(displayArgs(["--append-system-prompt", INTRO_TEXT, "--resume", "x"])).toEqual([
    "--append-system-prompt",
    "…ade-msg…",
    "--resume",
    "x",
  ])
  expect(displayArgs(introArgs("codex"))[1]).toBe("developer_instructions=…ade-msg…")
})
