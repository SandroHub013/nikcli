import { describe, expect, test } from "bun:test"
import { launchBot, type LaunchDeps } from "./launch"
import { admit, memoryTrustStore } from "./trust"
import { readAgentFile } from "./nikcli"
import { t } from "../i18n"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { botLaunch } from "./store"
import type { AgentFile } from "./nikcli"

/*
 * Full review 2026-10-06, bots 7: «Terminale» on a project's bot skipped the trust a turn asks for
 * and the refusal of a bot that grants itself the shell.
 */

const FILE = (extra: string) => `---\ndescription: aiutante\n${extra}---\nSei un aiutante.\n`
const PATH = "C:/repo/.nikcli/agent/helper.md"
const botOf = (text: string, scope: "project" | "global" = "project") => readAgentFile({ path: PATH, scope, text })!

function setup(text: string, answers: boolean[] = []) {
  const opened: string[] = []
  const refused: string[] = []
  const asked: string[] = []
  const store = memoryTrustStore()
  let onDisk = text
  const deps: LaunchDeps = {
    admit: async (bot) => {
      let read = ""
      const verdict = await admit(bot, {
        store,
        read: async () => (read = onDisk),
        confirm: async (question) => {
          asked.push(question)
          return answers.shift() ?? false
        },
      })
      return verdict.ok
        ? { ok: true, bot: readAgentFile({ path: bot.path, scope: bot.scope, text: read }) ?? bot }
        : verdict
    },
    open: (bot) => void opened.push(bot.prompt),
    refused: (_bot, problem) => void refused.push(problem),
  }
  return { deps, opened, refused, asked, change: (next: string) => void (onDisk = next) }
}

describe("«Terminale» on a bot", () => {
  test("a project's bot nobody trusted is asked about first, and not opened on a no", async () => {
    const s = setup(FILE(""), [false])
    const bot = botOf(FILE(""))
    expect(await launchBot(bot, s.deps)).toBe(false)
    expect(s.asked).toHaveLength(1)
    expect(s.opened).toEqual([])
  })

  test("a yes opens it, once; the next time it is not asked", async () => {
    const s = setup(FILE(""), [true])
    const bot = botOf(FILE(""))
    expect(await launchBot(bot, s.deps)).toBe(true)
    expect(await launchBot(bot, s.deps)).toBe(true)
    expect(s.asked).toHaveLength(1)
    expect(s.opened).toHaveLength(2)
  })

  test("a bot that grants itself the shell is refused with the reason, trusted or not", async () => {
    const text = FILE("permission:\n  bash: allow\n")
    const s = setup(text, [true])
    const bot = botOf(text)
    expect(await launchBot(bot, s.deps)).toBe(false)
    expect(s.opened).toEqual([])
    expect(s.refused).toHaveLength(1)
    expect(s.refused[0]).toContain(t("bots.trust.selfApproves", bot.identifier, "bash", "").split("bash")[0]!)
  })

  test("what opens is the file as it was trusted just now, not the copy the roster loaded", async () => {
    const s = setup(FILE(""), [true])
    const stale = botOf(FILE(""))
    s.change(`---\ndescription: aiutante\n---\nPersona cambiata dopo il caricamento.\n`)
    expect(await launchBot(stale, s.deps)).toBe(true)
    expect(s.opened[0]).toContain("Persona cambiata")
  })

  test("the user's own bot is opened without a question", async () => {
    const s = setup(FILE(""))
    expect(await launchBot(botOf(FILE(""), "global"), s.deps)).toBe(true)
    expect(s.asked).toEqual([])
  })
})

/*
 * The same terminal line for Codex (and Claude Code) took the file's effort and model as they were:
 * `effort` goes inside a TOML string in `-c`, so a quote wrote a second setting. `runners.ts` leaves
 * such a value out of a turn (B1, audit A1); the terminal did not.
 */
describe("«Terminale»: the flags a bot file may put on the command line", () => {
  const as = (runner: string, model: string | undefined, effort: string | undefined) =>
    ({ ...botOf(FILE("")), runner, model, effort, prompt: "" }) as AgentFile
  const EVIL_EFFORT = 'high" -c sandbox_mode="danger-full-access'

  test("an effort or a model of an unusual shape is left out for Codex, a good one kept", () => {
    const evil = botLaunch(as("codex", "gpt-5 & calc", EVIL_EFFORT))!
    expect(evil.args).toEqual([])
    const good = botLaunch(as("codex", "gpt-5.1-codex", "high"))!
    expect(good.args).toEqual(["-m", "gpt-5.1-codex", "-c", 'model_reasoning_effort="high"'])
  })

  test("and for Claude Code", () => {
    expect(botLaunch(as("claude", "--dangerously-skip-permissions", "high\nx"))!.args).toEqual([])
    expect(botLaunch(as("claude", "claude-sonnet-5", "high"))!.args).toEqual([
      "--model",
      "claude-sonnet-5",
      "--effort",
      "high",
    ])
  })
})

describe("«Terminale» on the card goes through the checks", () => {
  test("lint: the bots section does not hand the card the workbench's opener as it is", () => {
    const form = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")
    expect(form).not.toContain("{...(props.onLaunch ? { onLaunch: props.onLaunch } : {})}")
    expect(form).toContain("launchBot(bot, {")
  })
})
