import { afterEach, describe, expect, test } from "bun:test"
import { turnsRunning } from "./terms"
import type { TurnDeps, TurnRequest } from "./turn"
import { createWarmClaude, userMessageLine, type WarmClaude } from "./warm"

/*
 * A fake machine that keeps its processes: each spawn is recorded with its
 * arguments, what was written to it, and a way to make it print or exit.
 */
function machine() {
  const spawns: {
    args: string[]
    cwd?: string
    pipe?: boolean
    written: string[]
    killed: boolean
    say: (line: string) => void
    exit: (code: number | null) => void
  }[] = []
  const host = {
    mailboxDir: async () => "C:/box",
    spawn: async (options: {
      args: string[]
      cwd?: string
      pipe?: boolean
      onExit: (code: number | null) => void
      onLine: (line: string) => void
    }) => {
      const record = {
        args: options.args,
        cwd: options.cwd,
        pipe: options.pipe,
        written: [] as string[],
        killed: false,
        say: options.onLine,
        exit: options.onExit,
      }
      spawns.push(record)
      return {
        kill: () => void (record.killed = true),
        write: (data: string) => void record.written.push(data),
        resize: () => {},
      }
    },
  }
  const deps: TurnDeps = { host: async () => host as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>> }
  return { deps, spawns }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const answer = (session: string, text: string) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: session }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, session_id: session }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: session, total_cost_usd: 0 }),
]
const request = (message: string, extra: Partial<TurnRequest> = {}): TurnRequest => ({
  runner: "claude",
  message,
  cwd: "C:/p",
  instructions: "Sei nik.",
  disabledTools: ["edit", "write", "bash"],
  lean: true,
  partial: true,
  ...extra,
})

const opened: WarmClaude[] = []
afterEach(() => {
  for (const warm of opened.splice(0)) warm.close()
})
const warmOn = (m: ReturnType<typeof machine>) => {
  const warm = createWarmClaude(m.deps)
  opened.push(warm)
  return warm
}

describe("a Claude Code kept running between sentences", () => {
  test("started ahead on pipes, it answers one message per line, twice, in the same process", async () => {
    const m = machine()
    const warm = warmOn(m)
    warm.prepare(request(""))
    await tick()
    expect(m.spawns).toHaveLength(1)
    const [process] = m.spawns
    expect(process!.pipe).toBe(true)
    expect(process!.args).toContain("--input-format")
    expect(process!.args).not.toContain("--")
    expect(process!.cwd).toBe("C:/p")

    const first = warm.run(request("qual è la capitale della Francia?"))
    await tick()
    expect(process!.written).toEqual([`${userMessageLine("qual è la capitale della Francia?")}\n`])
    for (const line of answer("s1", "Parigi.")) process!.say(line)
    expect(await first.result).toMatchObject({ status: "done", text: "Parigi.", sessionId: "s1" })

    const second = warm.run(request("e della Spagna?"))
    await tick()
    for (const line of answer("s1", "Madrid.")) process!.say(line)
    expect(await second.result).toMatchObject({ status: "done", text: "Madrid." })
    expect(m.spawns).toHaveLength(1)
    expect(process!.written).toHaveLength(2)
    expect(turnsRunning("claude")).toBe(0)
  })

  test("another setting replaces the process and carries the conversation over", async () => {
    const m = machine()
    const warm = warmOn(m)
    const first = warm.run(request("ciao"))
    await tick()
    for (const line of answer("s1", "Ciao.")) m.spawns[0]!.say(line)
    await first.result

    const second = warm.run(request("e adesso?", { model: "claude-sonnet-5" }))
    await tick()
    expect(m.spawns[0]!.killed).toBe(true)
    expect(m.spawns).toHaveLength(2)
    expect(m.spawns[1]!.args.join(" ")).toContain("--resume s1")
    for (const line of answer("s1", "Eccomi.")) m.spawns[1]!.say(line)
    expect((await second.result).status).toBe("done")
  })

  test("another project starts a new conversation: the old one is not there", async () => {
    const m = machine()
    const warm = warmOn(m)
    const first = warm.run(request("ciao"))
    await tick()
    for (const line of answer("s1", "Ciao.")) m.spawns[0]!.say(line)
    await first.result

    const other = warm.run(request("e qui?", { cwd: "C:/altro" }))
    await tick()
    expect(m.spawns).toHaveLength(2)
    expect(m.spawns[1]!.cwd).toBe("C:/altro")
    expect(m.spawns[1]!.args).not.toContain("--resume")
    for (const line of answer("s2", "Eccomi.")) m.spawns[1]!.say(line)
    await other.result

    // Back in the first project: afresh too, never with the other project's conversation.
    const back = warm.run(request("e di nuovo?"))
    await tick()
    expect(m.spawns[2]!.args).not.toContain("--resume")
    back.stop()
    await back.result
  })

  test("closed when the voice stops, but not under a turn still answering", async () => {
    const m = machine()
    const warm = warmOn(m)
    warm.prepare(request(""))
    await tick()
    warm.close()
    expect(m.spawns[0]!.killed).toBe(true)

    const turn = warm.run(request("ciao"))
    await tick()
    warm.close()
    expect(m.spawns[1]!.killed).toBe(false)
    for (const line of answer("s1", "Ciao.")) m.spawns[1]!.say(line)
    expect((await turn.result).status).toBe("done")
  })

  test("a stopped turn takes its process with it; the next one resumes the conversation", async () => {
    const m = machine()
    const warm = warmOn(m)
    const first = warm.run(request("ciao"))
    await tick()
    m.spawns[0]!.say(answer("s1", "")[0]!)
    first.stop()
    expect((await first.result).status).toBe("stopped")
    expect(m.spawns[0]!.killed).toBe(true)

    const second = warm.run(request("ancora"))
    await tick()
    expect(m.spawns).toHaveLength(2)
    expect(m.spawns[1]!.args.join(" ")).toContain("--resume s1")
    second.stop()
    await second.result
  })

  test("a process that exits in the middle of a turn is an error, and the next turn starts another", async () => {
    const m = machine()
    const warm = warmOn(m)
    const first = warm.run(request("ciao"))
    await tick()
    m.spawns[0]!.say("Error: something broke")
    m.spawns[0]!.exit(1)
    const result = await first.result
    expect(result.status).toBe("error")
    const second = warm.run(request("ancora"))
    await tick()
    expect(m.spawns).toHaveLength(2)
    second.stop()
    await second.result
  })

  test("a turn past its time is stopped and said so", async () => {
    const m = machine()
    const warm = warmOn(m)
    const result = await warm.run(request("ciao", { timeoutMs: 20 })).result
    expect(result.status).toBe("error")
    expect(result.problem).toContain("non ha finito il turno")
    expect(m.spawns[0]!.killed).toBe(true)
  })

  test("forgetting starts the next conversation from nothing", async () => {
    const m = machine()
    const warm = warmOn(m)
    const first = warm.run(request("ciao"))
    await tick()
    for (const line of answer("s1", "Ciao.")) m.spawns[0]!.say(line)
    await first.result
    warm.forget()
    expect(m.spawns[0]!.killed).toBe(true)
    warm.prepare(request(""))
    await tick()
    expect(m.spawns[1]!.args).not.toContain("--resume")
  })

  test("left unused, the process is closed", async () => {
    const m = machine()
    const warm = createWarmClaude({ ...m.deps, idleMs: 20 })
    opened.push(warm)
    warm.prepare(request(""))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(m.spawns[0]!.killed).toBe(true)
  })
})
