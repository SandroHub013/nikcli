import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { LIST_MS, MINT_MS, MINT_SLOW_MS, waitForAnswer } from "./ask-cli"
import { mintedNikcliId } from "./resume"
import { en } from "../i18n/en"
import { it as italian } from "../i18n/it"

const ID = '{\n  "id": "ses_f2187fa39ffea42ThcJIS6p5l5",\n'

/** A command that prints `lines` after `afterMs`, and never exits on its own. */
function command(lines: string[], afterMs: number) {
  const killed: boolean[] = []
  const start = async (onLine: (line: string) => void) => {
    setTimeout(() => lines.forEach(onLine), afterMs)
    return { kill: () => void killed.push(true) }
  }
  return { start, killed }
}

describe("waiting for a CLI's answer", () => {
  test("an answer in time: read, the command killed, nothing said about being slow", async () => {
    const cli = command(ID.split("\n"), 5)
    let said = 0
    const answer = await waitForAnswer({ start: cli.start, read: mintedNikcliId, timeoutMs: 200, slow: { afterMs: 100, say: () => said++ } })
    expect(answer).toBe("ses_f2187fa39ffea42ThcJIS6p5l5")
    expect(cli.killed).toEqual([true])
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(said).toBe(0)
  })

  /*
   * Prova dal vivo 7, 1b: at the first opening both mints went past 15 s and
   * the TUIs started without an id. The mint now waits longer, and the pane
   * says why it is still waiting.
   */
  test("an answer after the slow mark: said once, still read", async () => {
    const cli = command(ID.split("\n"), 60)
    let said = 0
    const answer = await waitForAnswer({ start: cli.start, read: mintedNikcliId, timeoutMs: 200, slow: { afterMs: 20, say: () => said++ } })
    expect(said).toBe(1)
    expect(answer).toBe("ses_f2187fa39ffea42ThcJIS6p5l5")
  })

  test("no answer: undefined at the timeout, the command killed", async () => {
    const cli = command([], 0)
    let said = 0
    const began = Date.now()
    const answer = await waitForAnswer({ start: cli.start, read: mintedNikcliId, timeoutMs: 60, slow: { afterMs: 20, say: () => said++ } })
    expect(answer).toBeUndefined()
    expect(Date.now() - began).toBeGreaterThanOrEqual(55)
    expect(said).toBe(1)
    expect(cli.killed).toEqual([true])
  })

  test("a command that ends is read for what it printed; one that cannot start is undefined", async () => {
    const ended = await waitForAnswer({
      start: async (onLine, onExit) => {
        setTimeout(() => (onLine("[]"), onExit()), 5)
        return { kill: () => {} }
      },
      read: (output) => (output.includes("[]") ? null : undefined),
      timeoutMs: 200,
    })
    expect(ended).toBeNull()
    const refused = await waitForAnswer({ start: async () => Promise.reject(new Error("no")), read: mintedNikcliId, timeoutMs: 200 })
    expect(refused).toBeUndefined()
  })
})

describe("the mint's time", () => {
  test("30 s for the mint, said at 15; the list keeps 15", () => {
    expect(MINT_MS).toBe(30_000)
    expect(MINT_SLOW_MS).toBe(15_000)
    expect(LIST_MS).toBe(15_000)
    // The note says how much longer: what is left after the mark.
    expect(MINT_MS - MINT_SLOW_MS).toBe(15_000)
    expect(italian["resume.slowMint"]("nikcli")).toContain("fino a 15 secondi")
    expect(en["resume.slowMint"]("nikcli")).toContain("up to 15 more seconds")
  })

  test("the workbench gives the mint its time and its note, and the list its own", () => {
    const workbench = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    expect(workbench).toContain('slow: { afterMs: MINT_SLOW_MS, say: () => tellPane(paneId, t("resume.slowMint", label)) }')
    expect(workbench).toContain("askCli(command, plan.args, cwd, plan.read, timing)")
    expect(workbench).toContain("askCli(command, plan.args, cwd, read, { timeoutMs: LIST_MS })")
    expect(workbench).not.toContain("const MINT_MS = 15_000")
  })
})
