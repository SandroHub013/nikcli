import { beforeEach, describe, expect, test } from "bun:test"
import { codexVersion, forgetCodexVersion } from "./codex-version"

/*
 * bot-lettura-3: `codex --version`, for a Codex turn from a chat or a routine. Asked once per ADE start, with a time
 * limit; an answer that did not come is not kept, so the next turn asks again.
 */
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
          for (const line of answer.lines ?? ["codex-cli 0.162.1"]) options.onLine(line, "out")
          options.onExit(answer.code === undefined ? 0 : answer.code)
        }, 1)
      return { kill: () => void killed++ }
    },
  }
  return { host, asked, killed: () => killed }
}

describe("codex --version, for a turn from a chat or a routine", () => {
  beforeEach(() => forgetCodexVersion())

  test("asked once per start: the second turn does not ask again", async () => {
    const m = machine()
    expect(await codexVersion(m.host, "codex")).toBe("codex-cli 0.162.1")
    expect(await codexVersion(m.host, "codex")).toBe("codex-cli 0.162.1")
    expect(m.asked).toEqual([["codex", "--version"]])
  })

  test("no answer in time: null, the process stopped, and the next turn asks again", async () => {
    const m = machine({ never: true })
    expect(await codexVersion(m.host, "codex", 5)).toBeNull()
    expect(m.killed()).toBe(1)
    await codexVersion(m.host, "codex", 5)
    expect(m.asked.length).toBe(2)
  })

  test("the pty's colours and window title are not part of the answer", async () => {
    const m = machine({ lines: ["\u001b]0;C:\\npm\\codex.cmd\u0007\u001b[1mcodex-cli 0.162.1\u001b[0m"] })
    expect(await codexVersion(m.host, "codex")).toBe("codex-cli 0.162.1")
  })

  test("a failed command or no version in what it said: null", async () => {
    expect(await codexVersion(machine({ code: 1 }).host, "codex")).toBeNull()
    forgetCodexVersion()
    expect(await codexVersion(machine({ lines: ["command not found"] }).host, "codex")).toBeNull()
    forgetCodexVersion()
    expect(await codexVersion({}, "codex")).toBeNull()
  })
})
