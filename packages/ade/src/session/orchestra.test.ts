import { beforeEach, describe, expect, test } from "bun:test"
import {
  checkName,
  isReservedName,
  depthOf,
  descendants,
  excludeWithAde,
  forgetOpencodeVersion,
  modelArgs,
  nameTaken,
  opencodeVersion,
  parseMajorVersion,
  resultsDir,
  slugify,
  withoutModel,
  shouldDropOpencodeModel,
  worktreeArgs,
  worktreePlan,
  effortArgs,
  withoutEffort,
  dispatchChoice,
  isBaseRef,
  worktreeAddArgs,
} from "./orchestra"
import { USER as DECISIONS_USER } from "../decisions/answer"
import { USER as DESIGN_USER } from "../design/answer"

describe("names", () => {
  test("a usable name comes back trimmed", () => {
    expect(checkName("  revisore test ")).toEqual({ name: "revisore test" })
  })

  test("names the agent could not address afterwards are refused", () => {
    for (const bad of ["", "   ", "12", "web/api", 'a"b', "x".repeat(41)]) {
      expect("error" in checkName(bad)).toBe(true)
    }
  })

  test("«utente» is the user's name in the registers: no session can take it, however it is written", () => {
    for (const reserved of ["utente", "UTENTE", " Utente ", "u t e n t e", "uténte", "ut​ente", "ｕｔｅｎｔｅ"]) {
      expect("error" in checkName(reserved)).toBe(true)
      expect(isReservedName(reserved)).toBe(true)
    }
    // The same word the registers use, in both of them.
    expect(isReservedName(DECISIONS_USER)).toBe(true)
    expect(isReservedName(DESIGN_USER)).toBe(true)
    // Only the name itself.
    expect(checkName("utente finale")).toEqual({ name: "utente finale" })
    expect(checkName("utenti")).toEqual({ name: "utenti" })
  })

  test("a taken name is taken whatever the case", () => {
    expect(nameTaken(["Revisore", "codex"], "revisore")).toBe(true)
    expect(nameTaken(["Revisore"], "revisore-2")).toBe(false)
  })

  test("slugify makes a branch segment", () => {
    expect(slugify("Revisione più rapida!")).toBe("revisione-piu-rapida")
    expect(slugify("???")).toBe("sessione")
  })
})

test("a worktree goes beside the project, never inside a folder named like the user's own ADE worktree", () => {
  expect(worktreePlan("C:\\Users\\me\\Favorites\\ragu\\", "revisore")).toEqual({
    branch: "ade/revisore",
    path: "C:\\Users\\me\\Favorites\\ragu-worktrees\\revisore",
    container: "C:\\Users\\me\\Favorites\\ragu-worktrees",
  })
  expect(worktreePlan("/home/me/app", "x").path).toBe("/home/me/app-worktrees/x")
  expect(worktreePlan("C:\\Users\\me\\Favorites\\ragu", "codex").path).not.toContain("ragu-ade")
})

test("a worktree starts from the base asked for, and a base cannot be an option", () => {
  const plan = { branch: "ade/codex", path: "/w/codex" }
  expect(worktreeAddArgs(plan, "feat/ade")).toEqual(["worktree", "add", "-b", "ade/codex", "/w/codex", "feat/ade"])
  expect(worktreeAddArgs(plan)).toEqual(["worktree", "add", "-b", "ade/codex", "/w/codex"])
  expect(isBaseRef("feat/ade")).toBe(true)
  expect(isBaseRef("3fdf4d7bb")).toBe(true)
  expect(isBaseRef("--force")).toBe(false)
  expect(isBaseRef("a..b")).toBe(false)
})

describe("the tree of sessions", () => {
  const parents = new Map([
    ["child", "root"],
    ["grandchild", "child"],
    ["sibling", "root"],
  ])
  const parentOf = (id: string) => parents.get(id)

  test("depth counts the spawns above a session", () => {
    expect(depthOf("root", parentOf)).toBe(0)
    expect(depthOf("child", parentOf)).toBe(1)
    expect(depthOf("grandchild", parentOf)).toBe(2)
  })

  test("a cycle ends the count", () => {
    const loop = new Map([
      ["a", "b"],
      ["b", "a"],
    ])
    expect(depthOf("a", (id) => loop.get(id))).toBe(1)
  })

  test("descendants come children-last, so each closes before its parent", () => {
    const below = descendants("root", parents)
    expect(below).toContain("sibling")
    expect(below.indexOf("grandchild")).toBeLessThan(below.indexOf("child"))
    expect(descendants("grandchild", parents)).toEqual([])
  })
})

describe("options a session may choose for its subagent", () => {
  test("the model, with the flag each CLI takes", () => {
    expect(modelArgs("claude-code", "sonnet")).toEqual(["--model", "sonnet"])
    expect(modelArgs("codex", "gpt-5-codex")).toEqual(["-m", "gpt-5-codex"])
    expect(modelArgs("agy", "gemini-3.1-pro-high")).toEqual(["--model", "gemini-3.1-pro-high"])
    // OpenCode 1.x takes provider/model with --model. OpenCode 2.x dropped --model on the interactive CLI.
    expect(modelArgs("opencode", "opencode/deepseek-v4.1-flash-free", "1.19.2")).toEqual(["--model", "opencode/deepseek-v4.1-flash-free"])
    const v2 = modelArgs("opencode", "opencode/deepseek-v4.1-flash-free", "2.3.0")
    expect("error" in (v2 as object)).toBe(true)
    if ("error" in (v2 as object)) {
      expect((v2 as { error: string }).error).toContain("/models")
    }
    const vUnknown = modelArgs("opencode", "opencode/deepseek-v4.1-flash-free")
    expect("error" in (vUnknown as object)).toBe(true)
    if ("error" in (vUnknown as object)) {
      expect((vUnknown as { error: string }).error).toContain("Non riesco a leggere la versione")
      expect((vUnknown as { error: string }).error).not.toContain("OpenCode 2")
    }
    expect("error" in (modelArgs("opencode", "x --dangerously-skip-permissions") as object)).toBe(true)
  })

  test("not a way to smuggle other arguments in", () => {
    expect("error" in (modelArgs("claude-code", "x --dangerously-skip-permissions") as object)).toBe(true)
    expect("error" in (modelArgs("kimi", "k2") as object)).toBe(true)
  })

  test("a model name that begins with a dash is another flag, and is refused", () => {
    expect("error" in (modelArgs("claude-code", "--yolo") as object)).toBe(true)
    expect("error" in (modelArgs("claude-code", "-x") as object)).toBe(true)
    expect(modelArgs("claude-code", "claude-haiku-5-5")).toEqual(["--model", "claude-haiku-5-5"])
    expect(modelArgs("opencode", "opencode/deepseek-v4.1-flash-free", "1.19.2")).toEqual([
      "--model",
      "opencode/deepseek-v4.1-flash-free",
    ])
  })

  test("agy is told about its worktree, the others start in it", () => {
    expect(worktreeArgs("agy", "C:\\w\\x")).toEqual(["--add-dir", "C:\\w\\x"])
    expect(worktreeArgs("codex", "C:\\w\\x")).toEqual([])
  })
})

test("results live in .ade/results, kept out of git once", () => {
  expect(resultsDir("C:\\p\\app")).toBe("C:\\p\\app\\.ade\\results")
  expect(excludeWithAde("*.log")).toBe("*.log\n# ADE: risultati dei subagent\n.ade/\n")
  expect(excludeWithAde("# x\n.ade/\n")).toBeUndefined()
})

test("withoutModel takes the model choice out and leaves the rest", () => {
  expect(withoutModel(["--model", "a", "--add-dir", "C:\\w"])).toEqual(["--add-dir", "C:\\w"])
  expect(withoutModel(["-m", "gpt-5"])).toEqual([])
})

test("shouldDropOpencodeModel drops stored model on OpenCode 2.x and unknown version", () => {
  expect(shouldDropOpencodeModel("opencode", ["--model", "opencode/deepseek"], "2.3.0")).toBe(true)
  expect(shouldDropOpencodeModel("opencode", ["--model", "opencode/deepseek"], undefined)).toBe(true)
  expect(shouldDropOpencodeModel("opencode", ["--model", "opencode/deepseek"], null)).toBe(true)
  expect(shouldDropOpencodeModel("opencode", ["--model", "opencode/deepseek"], "1.19.2")).toBe(false)
  expect(shouldDropOpencodeModel("claude-code", ["--model", "haiku"], "2.3.0")).toBe(false)
  expect(shouldDropOpencodeModel("opencode", ["--verbose"], "2.3.0")).toBe(false)
})

describe("effort and dispatch profiles at spawn", () => {
  test("each agent is told the effort its own way, and one that cannot be told is refused", () => {
    expect(effortArgs("claude-code", "XHigh")).toEqual(["--effort", "xhigh"])
    expect(effortArgs("claude-code", "low", "sonnet")).toEqual(["--effort", "low"])
    expect(effortArgs("codex", "high")).toEqual(["-c", 'model_reasoning_effort="high"'])
    expect(effortArgs("agy", "max")).toEqual({ error: expect.stringContaining("low, medium, high") })
  })

  test("an effort the model would ignore is refused, as the transcripts showed", () => {
    expect(effortArgs("claude-code", "low", "haiku")).toEqual({ error: expect.stringContaining("ignora l'effort") })
    // agy carries the effort in the model id; its --effort flag is not applied.
    expect(effortArgs("agy", "medium", "gemini-3.8-flash-medium")).toEqual([])
    expect(effortArgs("agy", "high", "gemini-3.8-flash-medium")).toEqual({
      error: expect.stringContaining("gemini-3.8-flash-high"),
    })
    expect(effortArgs("agy", "high")).toEqual({ error: expect.stringContaining("--model") })
    expect(effortArgs("agy", "high", "claude-sonnet-4-6")).toEqual({ error: expect.stringContaining("non ha livelli") })
    expect(effortArgs("ragu", "high")).toEqual({ error: expect.stringContaining("variant") })
    expect(effortArgs("opencode", "high")).toEqual({ error: expect.stringContaining("senza --effort") })
  })

  test("a relaunch can replace the effort", () => {
    expect(withoutEffort(["--model", "haiku", "--effort", "low"])).toEqual(["--model", "haiku"])
    expect(withoutEffort(["-c", 'model_reasoning_effort="high"', "-c", 'sandbox_mode="x"'])).toEqual([
      "-c",
      'sandbox_mode="x"',
    ])
  })

  test("a profile gives the named agent its model and effort, and says why it cannot", () => {
    const json = JSON.stringify({
      classes: [
        {
          when: "revisione-audit",
          candidates: [{ agent: "claude-code", model: "claude-opus-5", effort: "high", why: "aderenza" }],
        },
        { when: "compito-piccolo", candidates: [{ agent: "agy", model: "gemini-3.8-flash-medium", effort: "medium" }] },
      ],
    })
    expect(dispatchChoice(json, "revisione-audit", "claude-code")).toEqual({
      model: "claude-opus-5",
      effort: "high",
      why: "aderenza",
    })
    expect(dispatchChoice(json, "revisione-audit", "agy")).toEqual({
      error: expect.stringContaining("candidati claude-code"),
    })
    expect(dispatchChoice(json, "boh", "agy")).toEqual({
      error: expect.stringContaining("revisione-audit, compito-piccolo"),
    })
    expect(dispatchChoice("{", "x", "agy")).toEqual({ error: "dispatch.json non è JSON valido" })
  })
})

function machine(answer: { lines?: readonly string[]; code?: number | null; never?: boolean } = {}) {
  const asked: (readonly string[])[] = []
  let killed = 0
  const host = {
    spawn: async (options: {
      command: string
      args: string[]
      onLine: (line: string, stream: "out" | "err") => void
      onExit: (code: number | null) => void
    }) => {
      asked.push([options.command, ...options.args])
      if (!answer.never)
        setTimeout(() => {
          for (const line of answer.lines ?? ["opencode v2.3.0"]) options.onLine(line, "out")
          options.onExit(answer.code === undefined ? 0 : answer.code)
        }, 1)
      return { kill: () => void killed++ }
    },
  }
  return { host, asked, killed: () => killed }
}

describe("parseMajorVersion", () => {
  test("extracts major version from CLI version text", () => {
    expect(parseMajorVersion("opencode v2.3.0")).toBe(2)
    expect(parseMajorVersion("opencode 2.0.0")).toBe(2)
    expect(parseMajorVersion("v1.19.2")).toBe(1)
    expect(parseMajorVersion("1.0.0")).toBe(1)
    expect(parseMajorVersion("")).toBeUndefined()
    expect(parseMajorVersion(null)).toBeUndefined()
    expect(parseMajorVersion(undefined)).toBeUndefined()
    expect(parseMajorVersion("non-version string")).toBeUndefined()
  })
})

describe("opencode --version, to check whether it accepts --model", () => {
  beforeEach(() => forgetOpencodeVersion())

  test("asked once per start: the second launch does not ask again", async () => {
    const m = machine({ lines: ["opencode v2.3.0"] })
    expect(await opencodeVersion(m.host, "opencode")).toBe("opencode v2.3.0")
    expect(await opencodeVersion(m.host, "opencode")).toBe("opencode v2.3.0")
    expect(m.asked).toEqual([["opencode", "--version"]])
  })

  test("a 1.x answer is not cached so an upgrade to 2.x is seen on the next spawn", async () => {
    const m = machine({ lines: ["opencode v1.19.2"] })
    expect(await opencodeVersion(m.host, "opencode")).toBe("opencode v1.19.2")
    expect(await opencodeVersion(m.host, "opencode")).toBe("opencode v1.19.2")
    expect(m.asked.length).toBe(2)
  })

  test("no answer in time: null, the process stopped, and the next turn asks again", async () => {
    const m = machine({ never: true })
    expect(await opencodeVersion(m.host, "opencode", 5)).toBeNull()
    expect(m.killed()).toBe(1)
    await opencodeVersion(m.host, "opencode", 5)
    expect(m.asked.length).toBe(2)
  })

  test("the pty's colours and window title are stripped", async () => {
    const m = machine({ lines: ["\u001b]0;opencode\u0007\u001b[1mopencode v2.3.0\u001b[0m"] })
    expect(await opencodeVersion(m.host, "opencode")).toBe("opencode v2.3.0")
  })

  test("a failed command or no version in what it said: null", async () => {
    expect(await opencodeVersion(machine({ code: 1 }).host, "opencode")).toBeNull()
    forgetOpencodeVersion()
    expect(await opencodeVersion(machine({ lines: ["command not found"] }).host, "opencode")).toBeNull()
    forgetOpencodeVersion()
    expect(await opencodeVersion({}, "opencode")).toBeNull()
  })
})
