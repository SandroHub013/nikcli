import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { LIST_MS, MINT_MS, MINT_SLOW_LEFT_S, MINT_SLOW_MS, mintTrace, waitForAnswer, type Timers } from "./ask-cli"
import { mintedNikcliId } from "./resume"
import { en } from "../i18n/en"
import { it as italian } from "../i18n/it"

const ID = '{\n  "id": "ses_f2187fa39ffea42ThcJIS6p5l5",\n'

/*
 * A clock the test moves by hand. The waits used to run on real timers with
 * margins of 20-200 ms, which a loaded machine can miss (review of
 * ripristino-sexies, nota 3).
 */
function clock() {
  let now = 0
  let seq = 0
  const due = new Map<number, { at: number; run: () => void }>()
  const timers: Timers = {
    set: (run, ms) => {
      due.set(++seq, { at: now + ms, run })
      return seq
    },
    clear: (handle) => void due.delete(handle as number),
  }
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      const next = [...due.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      due.delete(next[0])
      now = next[1].at
      next[1].run()
      await settle()
    }
    now = end
    await settle()
  }
  return { timers, advance }
}

/** Lets the promises already resolved run their callbacks. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** A command that prints `lines` at `afterMs` on the clock, and never exits on its own. */
function command(timers: Timers, lines: string[], afterMs: number) {
  const killed: boolean[] = []
  const start = async (onLine: (line: string) => void) => {
    timers.set(() => lines.forEach(onLine), afterMs)
    return { kill: () => void killed.push(true) }
  }
  return { start, killed }
}

describe("waiting for a CLI's answer", () => {
  test("an answer in time: read, the command killed, nothing said about being slow", async () => {
    const { timers, advance } = clock()
    const cli = command(timers, ID.split("\n"), 2_000)
    let said = 0
    const answer = waitForAnswer({ start: cli.start, read: mintedNikcliId, timeoutMs: MINT_MS, slow: { afterMs: MINT_SLOW_MS, say: () => said++ }, timers })
    await settle()
    await advance(2_000)
    expect(await answer).toBe("ses_f2187fa39ffea42ThcJIS6p5l5")
    expect(cli.killed).toEqual([true])
    await advance(60_000)
    expect(said).toBe(0)
  })

  /*
   * Prova dal vivo 7, 1b: at the first opening both mints went past 15 s and
   * the TUIs started without an id. The mint now waits longer, and the pane
   * says why it is still waiting.
   */
  test("an answer after the slow mark: said once, still read", async () => {
    const { timers, advance } = clock()
    const cli = command(timers, ID.split("\n"), 20_000)
    let said = 0
    let answered: string | null | undefined
    const answer = waitForAnswer({ start: cli.start, read: mintedNikcliId, timeoutMs: MINT_MS, slow: { afterMs: MINT_SLOW_MS, say: () => said++ }, timers })
    void answer.then((id) => (answered = id))
    await settle()
    await advance(MINT_SLOW_MS)
    expect(said).toBe(1)
    expect(answered).toBeUndefined()
    await advance(5_000)
    expect(await answer).toBe("ses_f2187fa39ffea42ThcJIS6p5l5")
    expect(said).toBe(1)
  })

  test("no answer: undefined at the timeout and not before, the command killed", async () => {
    const { timers, advance } = clock()
    const cli = command(timers, [], 0)
    let said = 0
    let done = false
    const answer = waitForAnswer({ start: cli.start, read: mintedNikcliId, timeoutMs: MINT_MS, slow: { afterMs: MINT_SLOW_MS, say: () => said++ }, timers })
    void answer.then(() => (done = true))
    await settle()
    await advance(MINT_MS - 1)
    expect(done).toBe(false)
    await advance(1)
    expect(await answer).toBeUndefined()
    expect(said).toBe(1)
    expect(cli.killed).toEqual([true])
  })

  test("a command that ends is read for what it printed; one that cannot start is undefined", async () => {
    const { timers, advance } = clock()
    const ended = waitForAnswer({
      start: async (onLine, onExit) => {
        timers.set(() => (onLine("[]"), onExit()), 5)
        return { kill: () => {} }
      },
      read: (output) => (output.includes("[]") ? null : undefined),
      timeoutMs: LIST_MS,
      timers,
    })
    await settle()
    await advance(5)
    expect(await ended).toBeNull()
    const refused = await waitForAnswer({ start: async () => Promise.reject(new Error("no")), read: mintedNikcliId, timeoutMs: LIST_MS, timers })
    expect(refused).toBeUndefined()
  })
})

describe("the mint's time", () => {
  test("30 s for the mint, said at 15; the list keeps 15", () => {
    expect(MINT_MS).toBe(30_000)
    expect(MINT_SLOW_MS).toBe(15_000)
    expect(LIST_MS).toBe(15_000)
  })

  /* Review of ripristino-sexies, nota 2: «15 secondi» was written by hand. */
  test("the note says the seconds left after it, from the constants", () => {
    expect(MINT_SLOW_LEFT_S).toBe((MINT_MS - MINT_SLOW_MS) / 1000)
    expect(italian["resume.slowMint"]("nikcli", MINT_SLOW_LEFT_S)).toContain("fino a 15 secondi")
    expect(italian["resume.slowMint"]("nikcli", 7)).toContain("fino a 7 secondi")
    expect(en["resume.slowMint"]("nikcli", 7)).toContain("up to 7 more seconds")
  })

  test("the workbench gives the mint its time and its note, and the list its own", () => {
    const workbench = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    expect(workbench).toContain('say: () => tellPane(paneId, t("resume.slowMint", label, MINT_SLOW_LEFT_S))')
    expect(workbench).toContain("askCli(command, plan.args, cwd, read, timing)")
    expect(workbench).toContain("askCli(command, plan.args, cwd, read, { timeoutMs: LIST_MS })")
    expect(workbench).not.toContain("const MINT_MS = 15_000")
  })
})

/*
 * Review of ripristino-sexies: the slow mint's cause was never found. Each
 * mint now leaves a line in the console, with what the CLI printed first.
 */
describe("the mint's trace", () => {
  /*
   * Review of ripristino-septies: in session.create's JSON the title is
   * escaped, and splitting on the raw title left the user's task in the line.
   */
  const TITLE = 'Sistema "il" login\\admin · 5998-1-1'
  const ESCAPED = JSON.stringify(TITLE)

  test("the answer's JSON is said by its size only, the title in it or not", () => {
    const json = `{ "title": ${ESCAPED}, "id": "ses_x" }`
    const line = mintTrace({ agent: "nikcli", ms: 16_234.6, outcome: "id", first: { ms: 15_900.2, line: `  ${json}` }, title: TITLE })
    expect(line).toBe(`[ade.mint] nikcli: id in 16235 ms, first output at 15900 ms: json, ${json.length} chars`)
    expect(line).not.toContain("login")
    expect(mintTrace({ agent: "nikcli", ms: 1, outcome: "none", first: { ms: 1, line: "[]" }, title: TITLE })).toEndWith(": json, 2 chars")
  })

  test("another first line is kept, the title taken out raw and escaped", () => {
    const raw = mintTrace({ agent: "nikcli", ms: 2_000, outcome: "id", first: { ms: 1_500, line: `creating ${TITLE} now` }, title: TITLE })
    const escaped = mintTrace({ agent: "nikcli", ms: 2_000, outcome: "id", first: { ms: 1_500, line: `creating ${ESCAPED} now` }, title: TITLE })
    expect(raw).toBe('[ade.mint] nikcli: id in 2000 ms, first output at 1500 ms: "creating \u2026 now"')
    expect(escaped).toBe('[ade.mint] nikcli: id in 2000 ms, first output at 1500 ms: "creating \\"\u2026\\" now"')
    expect(raw + escaped).not.toContain("login")
    const plain = mintTrace({ agent: "nikcli", ms: 9, outcome: "timeout", first: { ms: 8, line: "Installing @nikcli-ai/plugin" }, title: TITLE })
    expect(plain).toEndWith(': "Installing @nikcli-ai/plugin"')
  })

  test("a mint that printed nothing says so; a long first line is cut", () => {
    expect(mintTrace({ agent: "nikcli", ms: 30_000, outcome: "timeout", title: "x" })).toBe("[ade.mint] nikcli: timeout in 30000 ms, nothing printed")
    const long = mintTrace({ agent: "nikcli", ms: 10, outcome: "none", first: { ms: 5, line: "a".repeat(500) }, title: "" })
    expect(long).toContain(`"${"a".repeat(200)}"`)
    expect(long).not.toContain("a".repeat(201))
  })

  test("the workbench traces every mint, fast or slow", () => {
    const workbench = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    expect(workbench).toContain("console.info(mintTrace({ agent: agentId, ms: performance.now() - began, outcome, first, title }))")
  })
})
