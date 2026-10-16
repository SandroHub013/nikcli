import { describe, expect, test } from "bun:test"
import type { Host } from "../host"
import { createBot, writeBot, type CreateBotInput } from "./store"
import { readAgentFile } from "./ragu"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const input = {
  name: "news",
  scope: "project",
  description: "d",
  persona: "Sei news.",
  mode: "primary",
  home: "C:/p/.nikcli",
  base: "C:/p",
} as unknown as CreateBotInput & { home: string; base: string; mode: "primary" }

describe("writeBot and a check that fails (review of F7d, O1)", () => {
  test("a rejected existence check is said, and nothing is written over what may be there", async () => {
    const written: string[] = []
    const host = {
      exists: async () => {
        throw new Error("unità non pronta")
      },
      writeTextFile: async (path: string) => {
        written.push(path)
        return null
      },
    } as unknown as Host
    const result = await writeBot(input, host)
    expect(result).toEqual({ ok: false, problem: "unità non pronta" })
    expect(written).toEqual([])
  })

  test("a file that is there is refused, and a free name is written", async () => {
    const written: string[] = []
    const make = (there: boolean) =>
      ({
        exists: async () => there,
        writeTextFile: async (path: string) => {
          written.push(path)
          return null
        },
      }) as unknown as Host
    const refused = await writeBot(input, make(true))
    expect(refused.ok).toBe(false)
    expect(written).toEqual([])
    const done = await writeBot(input, make(false))
    expect(done.ok).toBe(true)
    expect(written).toHaveLength(1)
  })
})

describe("the name written in the form is the bot's name, with the instructions ragu writes (bot-ui-3, 1)", () => {
  const generated = [
    "---",
    'description: "Use this agent to review pull requests"',
    "mode: primary",
    "---",
    "You review pull requests and point out the risks.",
    "",
  ].join("\n")
  const fake = (options: { createdAt?: string; there?: boolean; writeFails?: string } = {}) => {
    const created = options.createdAt ?? "C:/p/.ragu/agent/pr-reviewer.md"
    const calls = { ragu: [] as string[][], written: [] as [string, string][], deleted: [] as string[] }
    const host = {
      readDir: async () => [],
      exists: async () => options.there === true,
      raguBot: async (args: string[]) => {
        calls.ragu.push(args)
        return { code: 0, stdout: `${created}\n`, stderr: "" }
      },
      readTextFile: async () => ({ text: generated }),
      writeTextFile: async (path: string, text: string) => {
        calls.written.push([path, text])
        return options.writeFails ?? null
      },
      deleteBotFile: async (path: string) => {
        calls.deleted.push(path)
        return null
      },
    } as unknown as Host
    return { host, calls }
  }
  const ask: CreateBotInput = { name: "Revisore PR", scope: "project", description: "Rivede le pull request" }

  test("ragu writes the instructions, the file takes the name the user wrote, ragu's own file goes", async () => {
    const { host, calls } = fake()
    const result = await createBot(ask, { project: "C:/p" }, async () => host)
    expect(result).toEqual({ ok: true, path: "C:/p/.ragu/agent/revisore-pr.md", identifier: "revisore-pr" })
    expect(calls.ragu).toHaveLength(1)
    expect(calls.written.map(([path]) => path)).toEqual(["C:/p/.ragu/agent/revisore-pr.md"])
    const bot = readAgentFile({ path: "C:/p/.ragu/agent/revisore-pr.md", scope: "project", text: calls.written[0]![1] })
    // What it is for is the user's words; the instructions are ragu's.
    expect(bot.description).toBe("Rivede le pull request")
    expect(bot.prompt).toContain("You review pull requests")
    expect(calls.deleted).toEqual(["C:/p/.ragu/agent/pr-reviewer.md"])
  })

  test("ragu chose the same name: one file, nothing deleted", async () => {
    const { host, calls } = fake({ createdAt: "C:\\p\\.ragu\\agent\\revisore-pr.md" })
    const result = await createBot(ask, { project: "C:/p" }, async () => host)
    expect(result.ok).toBe(true)
    expect(calls.deleted).toEqual([])
  })

  test("a bot by that name already there: refused before ragu is asked, so nothing is paid for", async () => {
    const { host, calls } = fake({ there: true })
    const result = await createBot(ask, { project: "C:/p" }, async () => host)
    expect(result.ok).toBe(false)
    expect(calls.ragu).toEqual([])
  })

  test("the file under the user's name cannot be written: ragu's goes too, and the failure is said", async () => {
    const { host, calls } = fake({ writeFails: "accesso negato" })
    const result = await createBot(ask, { project: "C:/p" }, async () => host)
    expect(result).toEqual({ ok: false, problem: "accesso negato" })
    expect(calls.deleted).toEqual(["C:/p/.ragu/agent/pr-reviewer.md"])
  })

  test("lint: the form asks for a name on both routes, and says the same of it", () => {
    const tsx = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")
    const form = tsx.slice(tsx.indexOf("function BotForm("), tsx.indexOf("/* ── the settings, in the card"))
    expect(form).toContain("if (name().trim().length === 0) {")
    expect(form).not.toContain("bots.form.hintGenerating")
    expect(form).toContain('t("bots.form.hintNamed")')
  })
})
