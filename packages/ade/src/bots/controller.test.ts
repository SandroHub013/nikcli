import { describe, expect, test } from "bun:test"
import type { AgentFile } from "./nikcli"
import { withAlways } from "./approval"
import { createBotTurns } from "./controller"
import { acquireTurn, turnsRunning } from "./terms"
import { appendMessage, emptyTalk, type Talk } from "./talk"
import { confirmProposal, volatileMemoryStore } from "./memory"
import { runTurn, type TurnDeps, type TurnRequest, type TurnResult } from "./turn"

/*
 * B2 (audit A2, A3): the Bots panel's turns, without the panel.
 *
 * «Ferma» and «Nuova conversazione» killed the process after its listeners
 * were gone, so the exit never came: the bot stayed «working», the next
 * message went nowhere, and each stop kept one of the plan's three places —
 * after three, the voice was refused too. A runner that did not start looked
 * like one that answered nothing. The fake machine below behaves as
 * `host/shell.ts` does: a killed session never reports its exit, and a spawn
 * the host refuses reports an "err" line and an exit, then returns a handle.
 */
function machine(options: { refuse?: string } = {}) {
  const kills: { tree?: boolean }[] = []
  const exits: ((code: number | null) => void)[] = []
  const lines: ((line: string, stream: "out" | "err") => void)[] = []
  const writes: string[] = []
  const flags: (readonly string[] | undefined)[] = []
  const secrets: (readonly string[] | undefined)[] = []
  const argv: (readonly string[])[] = []
  const host = {
    spawn: async (spawn: {
      args?: readonly string[]
      flags?: readonly string[]
      secrets?: readonly string[]
      onExit: (code: number | null) => void
      onLine: (line: string, stream: "out" | "err") => void
    }) => {
      exits.push(spawn.onExit)
      lines.push(spawn.onLine)
      flags.push(spawn.flags)
      secrets.push(spawn.secrets)
      argv.push(spawn.args ?? [])
      if (options.refuse) {
        spawn.onLine(options.refuse, "err")
        spawn.onExit(null)
      }
      return {
        kill: (kill?: { tree?: boolean }) => void kills.push(kill ?? {}),
        write: (keys: string) => void writes.push(keys),
        resize: () => {},
      }
    },
  }
  const deps: TurnDeps = { host: async () => host as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>> }
  return {
    deps,
    kills,
    writes,
    spawned: () => exits.length,
    flags,
    secrets,
    argv,
    exit: (code: number | null, at = exits.length - 1) => exits[at]?.(code),
    say: (line: string, at = lines.length - 1) => lines[at]?.(line, "out"),
  }
}

function panel(
  m: ReturnType<typeof machine>,
  accountOf?: (path: string) => { mode: "plan" } | { mode: "key"; key: string },
) {
  const talks: Record<string, Talk> = {}
  const kept: Record<string, string[]> = {}
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
  const turns = createBotTurns({
    runTurn: (request) => runTurn(request, m.deps),
    talkOf: (path) => talks[path] ?? emptyTalk(),
    update: (path, change) => {
      talks[path] = change(talks[path] ?? emptyTalk())
    },
    ...(accountOf ? { accountOf } : {}),
    always: {
      get: (path) => kept[path] ?? [],
      add: (path, key) => void (kept[path] = withAlways(kept[path] ?? [], key)),
    },
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false }
      timers.push(timer)
      return () => void (timer.cancelled = true)
    },
  })
  return { turns, talk: (path: string) => talks[path] ?? emptyTalk(), kept, timers }
}

const bot = (runner: string, path = `C:/p/.nikcli/agent/${runner}.md`): AgentFile => ({
  identifier: runner,
  path,
  scope: "project",
  description: "",
  mode: "primary",
  prompt: "",
  disabledTools: [],
  runner,
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("the Bots panel's turns", () => {
  test("«Ferma», then a new message starts a new turn", async () => {
    const m = machine()
    const p = panel(m)
    const claude = bot("claude")
    expect(p.turns.send(claude, "primo")).toBe(true)
    await tick()
    expect(p.talk(claude.path).status).toBe("working")

    p.turns.stop(claude)
    await tick()
    expect(m.kills).toEqual([{ tree: true }])
    expect(p.turns.running(claude.path)).toBe(false)
    expect(p.talk(claude.path).status).toBe("idle")

    expect(p.turns.send(claude, "secondo")).toBe(true)
    await tick()
    expect(m.spawned()).toBe(2)
    p.turns.stop(claude)
    await tick()
  })

  test("three stops in a row give every place back: the voice is not refused", async () => {
    const m = machine()
    const p = panel(m)
    const claude = bot("claude")
    for (let i = 0; i < 3; i++) {
      p.turns.send(claude, `messaggio ${i}`)
      await tick()
      p.turns.stop(claude)
      await tick()
    }
    expect(turnsRunning("claude")).toBe(0)
    const voice = acquireTurn("claude", "Claude Code")
    expect("problem" in voice).toBe(false)
    if (!("problem" in voice)) voice.release()
  })

  test("«Nuova conversazione» during a turn: an empty thread, the place back, nothing late written into it", async () => {
    const m = machine()
    const p = panel(m)
    const codex = bot("codex")
    p.turns.send(codex, "ciao")
    await tick()
    p.turns.forget(codex)
    await tick()
    expect(p.talk(codex.path).messages).toEqual([])
    expect(p.turns.running(codex.path)).toBe(false)
    expect(turnsRunning("codex")).toBe(0)
    expect(m.kills).toEqual([{ tree: true }])
    m.say('{"type":"item.completed","item":{"type":"agent_message","text":"tardi"}}', 0)
    await tick()
    expect(p.talk(codex.path).messages).toEqual([])
  })

  test("a runner that does not start: the error is in the thread and the place is free", async () => {
    const m = machine({ refuse: "comando non consentito: codex" })
    const p = panel(m)
    const codex = bot("codex")
    p.turns.send(codex, "ciao")
    await tick()
    const talk = p.talk(codex.path)
    expect(talk.status).toBe("error")
    expect(talk.problem).toContain("comando non consentito: codex")
    expect(p.turns.running(codex.path)).toBe(false)
    expect(turnsRunning("codex")).toBe(0)
    expect(p.turns.send(codex, "di nuovo")).toBe(true)
    await tick()
  })

  test("B1's refusal of an unsafe argument is the error the thread shows (B1 review, BASSO 3)", async () => {
    const refusal = "argomento non sicuro per codex.cmd: contiene U+000A, che cmd.exe interpreta"
    const m = machine({ refuse: refusal })
    const p = panel(m)
    const codex = bot("codex")
    p.turns.send(codex, "riga uno\nriga due")
    await tick()
    expect(p.talk(codex.path).problem).toBe(`Codex non si avvia: ${refusal}`)
  })

  test("a turn that ends on its own: the answer stays, the thread is idle, the next one continues it", async () => {
    const m = machine()
    const p = panel(m)
    const codex = bot("codex")
    p.turns.send(codex, "ciao")
    await tick()
    m.say('{"type":"thread.started","thread_id":"t-9"}')
    m.say('{"type":"item.completed","item":{"type":"agent_message","text":"eccomi"}}')
    m.say('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}')
    m.exit(0)
    await tick()
    const talk = p.talk(codex.path)
    expect(talk.status).toBe("idle")
    expect(talk.messages.some((message) => message.text === "eccomi")).toBe(true)
    expect(talk.sessionId).toBe("t-9")
    expect(p.turns.running(codex.path)).toBe(false)
  })

  test("«Sempre» on a command Claude Code was refused: kept for the bot, and the offer goes", async () => {
    const m = machine()
    const p = panel(m)
    const claude = bot("claude", "C:/u/.nikcli/agent/claude.md")
    p.turns.send(claude, "spingi")
    await tick()
    m.say(
      '{"type":"result","is_error":false,"session_id":"s","permission_denials":[{"tool_name":"Bash","tool_input":{"command":"git push -f"}}]}',
    )
    expect(p.talk(claude.path).offer).toMatchObject({ always: ["gitRewrite"] })
    p.turns.grant(claude)
    expect(p.kept[claude.path]).toEqual(["gitRewrite"])
    expect(p.talk(claude.path).offer).toBeUndefined()
    p.turns.stop(claude)
    await tick()
  })

  test("a second message while one runs is not started", async () => {
    const m = machine()
    const p = panel(m)
    const claude = bot("claude")
    expect(p.turns.send(claude, "uno")).toBe(true)
    expect(p.turns.send(claude, "due")).toBe(false)
    await tick()
    expect(m.spawned()).toBe(1)
    p.turns.stop(claude)
    await tick()
  })

  test("il turno del pannello porta il flag dell'account, e una chiave il suo nome", async () => {
    const m = machine()
    const p = panel(m, () => ({ mode: "key", key: "lavoro" }))
    const claude = bot("claude")
    p.turns.send(claude, "ciao")
    await tick()
    expect(m.flags[0]).toEqual(["account-key"])
    expect(m.secrets[0]).toEqual(["lavoro"])
    p.turns.stop(claude)
    await tick()
  })
})

/*
 * B11: a routine's run is the bot's own turn, in its thread, but nobody is
 * there to answer: no approvals and no shell, whatever the panel allows.
 */
describe("a routine's run", () => {
  test("Claude Code is refused the shell for a routine, not in the panel", async () => {
    const m = machine()
    const p = panel(m)
    // The user's own bot: a project's never has the shell, routine or not.
    const claude: AgentFile = { ...bot("claude"), scope: "global" }
    const disallowed = (at: number) => {
      const args = m.argv[at] ?? []
      return args[args.indexOf("--disallowedTools") + 1] ?? ""
    }
    const allowed = (at: number) => {
      const args = m.argv[at] ?? []
      return args[args.indexOf("--allowedTools") + 1] ?? ""
    }
    const turn = p.turns.routine(claude, "fai il punto", undefined, { maxCostUsd: 0.05 })
    await tick()
    expect(disallowed(0).split(",")).toContain("Bash")
    // The run's cap reaches Claude Code (review, M1); the panel's own turn has none.
    expect(m.argv[0]).toContain("--max-budget-usd")
    expect(allowed(0).split(",")).not.toContain("Bash")
    m.exit(0)
    await turn!.result
    p.turns.send(claude, "a mano")
    await tick()
    expect(allowed(1).split(",")).toContain("Bash")
    expect(m.argv[1]).not.toContain("--max-budget-usd")
    // Its place on the plan back, for the tests after this one.
    p.turns.stop(claude)
    await tick()
  })
})

/*
 * B8a: a bot's memory. Its snapshot opens a conversation and nothing after,
 * so what the bot writes shows from the next one; the tags leave its words.
 */
describe("a bot's memory in its turns", () => {
  function memoryPanel() {
    const talks: Record<string, Talk> = {}
    const requests: TurnRequest[] = []
    const finish: ((result: TurnResult) => void)[] = []
    const memory = volatileMemoryStore()
    const turns = createBotTurns({
      runTurn: (request) => {
        requests.push(request)
        const result = new Promise<TurnResult>((resolve) => finish.push(resolve))
        return { result, stop: () => {} }
      },
      talkOf: (path) => talks[path] ?? emptyTalk(),
      update: (path, change) => {
        talks[path] = change(talks[path] ?? emptyTalk())
      },
      memory,
    })
    const done = async () => {
      finish.at(-1)!({ status: "done", text: "", tokens: 0, costUsd: 0, exitCode: 0, talk: emptyTalk() })
      await tick()
    }
    return { talks, requests, memory, turns, done }
  }

  test("the snapshot opens the conversation only, and a write lands for the next one", async () => {
    const p = memoryPanel()
    const nikcli = bot("nikcli")
    p.memory.set(nikcli.path, { notes: ["Il progetto usa bun."], user: [] })
    p.turns.send(nikcli, "ciao")
    expect(p.requests[0]!.message).toContain("Il progetto usa bun.")
    expect(p.requests[0]!.message.endsWith("ciao")).toBe(true)
    // The bot answers with a write; its session is under way.
    p.talks[nikcli.path] = {
      ...appendMessage(
        p.talks[nikcli.path]!,
        { role: "bot", text: 'Ciao!\n<ade-memory op="add" block="user">Si chiama Mario.</ade-memory>' },
        1,
      ),
      sessionId: "s1",
    }
    await p.done()
    const thread = p.talks[nikcli.path]!.messages
    expect(thread.find((message) => message.role === "bot")?.text).toBe("Ciao!")
    expect(thread.at(-1)?.role).toBe("tool")
    // The profile waits for the user's click (review), then is written.
    expect(p.memory.get(nikcli.path).user).toEqual([])
    const [proposal] = p.memory.get(nikcli.path).proposals ?? []
    expect(proposal?.op).toEqual({ op: "add", block: "user", text: "Si chiama Mario." })
    const confirmed = confirmProposal(p.memory.get(nikcli.path), proposal!.id)
    p.memory.set(nikcli.path, confirmed.memory)
    expect(p.memory.get(nikcli.path).user).toEqual(["Si chiama Mario."])
    expect(p.memory.get(nikcli.path).proposals).toBeUndefined()
    // Same conversation: no snapshot again, whatever changed.
    p.turns.send(nikcli, "e poi?")
    // Only told that its write waits for the user.
    expect(p.requests[1]!.message).not.toContain("NOTE DEL BOT")
    expect(p.requests[1]!.message).toContain("in attesa che l'utente la confermi")
    expect(p.requests[1]!.message.endsWith("e poi?")).toBe(true)
    await p.done()
    // A new conversation sees the write.
    p.turns.forget(nikcli)
    p.turns.send(nikcli, "di nuovo")
    expect(p.requests[2]!.message).toContain("Si chiama Mario.")
  })

  test("«Annulla» on the thread takes a write back, while nothing changed its block since (review)", async () => {
    const p = memoryPanel()
    const nikcli = bot("nikcli")
    p.turns.send(nikcli, "ricorda")
    p.talks[nikcli.path] = {
      ...appendMessage(
        p.talks[nikcli.path]!,
        {
          role: "bot",
          text: '<ade-memory op="add" block="notes">Usa bun.</ade-memory>\n<ade-memory op="add" block="notes">I test stanno in src.</ade-memory>',
        },
        1,
      ),
      sessionId: "s1",
    }
    await p.done()
    const lines = p.talks[nikcli.path]!.messages.filter((message) => message.memoryUndo)
    expect(lines).toHaveLength(2)
    expect(p.memory.get(nikcli.path).notes).toEqual(["Usa bun.", "I test stanno in src."])
    // The first write: the second changed the block after it, so it is not undone.
    p.turns.undoMemory(nikcli, lines[0]!.id)
    expect(p.memory.get(nikcli.path).notes).toEqual(["Usa bun.", "I test stanno in src."])
    expect(p.talks[nikcli.path]!.messages.at(-1)?.role).toBe("error")
    // The last write comes back out, and its line loses the button.
    p.turns.undoMemory(nikcli, lines[1]!.id)
    expect(p.memory.get(nikcli.path).notes).toEqual(["Usa bun."])
    const thread = p.talks[nikcli.path]!.messages
    expect(thread.find((message) => message.id === lines[1]!.id)?.memoryUndo).toBeUndefined()
    expect(thread.at(-1)?.text).toContain("annullata")
    // Telling the bot about a failure keeps what can still be undone.
    const kept = { id: "u1", block: "notes" as const, before: [], after: ["Usa bun."] }
    p.memory.set(nikcli.path, { ...p.memory.get(nikcli.path), undo: [kept], pending: ["x"] })
    await p.done()
    p.turns.send(nikcli, "ok")
    expect(p.memory.get(nikcli.path).pending).toBeUndefined()
    expect(p.memory.get(nikcli.path).undo).toEqual([kept])
  })

  test("a routine's writes all wait for the user: nobody was there to see them (review)", async () => {
    const p = memoryPanel()
    const nikcli = bot("nikcli")
    p.turns.routine(nikcli, "fai il punto")
    p.talks[nikcli.path] = {
      ...appendMessage(
        p.talks[nikcli.path]!,
        { role: "bot", text: '<ade-memory op="add" block="notes">Usa bun.</ade-memory>' },
        1,
      ),
      sessionId: "s1",
    }
    await p.done()
    expect(p.memory.get(nikcli.path).notes).toEqual([])
    expect(p.memory.get(nikcli.path).proposals?.map((proposal) => [proposal.from, proposal.op.block])).toEqual([
      ["routine", "notes"],
    ])
    expect(p.talks[nikcli.path]!.messages.some((message) => message.memoryUndo)).toBe(false)
  })

  test("a room's writes all wait for the user too (B8b)", async () => {
    const p = memoryPanel()
    const nikcli = bot("nikcli")
    const thread = `room:r1:${nikcli.path}`
    p.turns.room(nikcli, "tocca a te", thread)
    p.talks[thread] = {
      ...appendMessage(
        p.talks[thread]!,
        { role: "bot", text: 'Ecco.\n<ade-memory op="add" block="notes">Usa bun.</ade-memory>' },
        1,
      ),
      sessionId: "s1",
    }
    await p.done()
    expect(p.memory.get(nikcli.path).notes).toEqual([])
    expect(p.memory.get(nikcli.path).proposals?.map((proposal) => proposal.from)).toEqual(["room"])
    expect(p.talks[thread]!.messages.find((message) => message.role === "bot")?.text).toBe("Ecco.")
    expect(p.talks[nikcli.path]).toBeUndefined()
  })

  test("a refused write is said in the thread, and to the bot on its next turn", async () => {
    const p = memoryPanel()
    const nikcli = bot("nikcli")
    p.turns.send(nikcli, "ricorda la chiave")
    p.talks[nikcli.path] = {
      ...appendMessage(
        p.talks[nikcli.path]!,
        { role: "bot", text: '<ade-memory op="add" block="notes">sk-abcdefghijklmnopqrstuvwxyz123456</ade-memory>' },
        1,
      ),
      sessionId: "s1",
    }
    await p.done()
    expect(p.memory.get(nikcli.path).notes).toEqual([])
    const thread = p.talks[nikcli.path]!.messages
    // The answer held only the tag: no empty bubble is left.
    expect(thread.some((message) => message.role === "bot")).toBe(false)
    expect(thread.at(-1)?.role).toBe("error")
    p.turns.send(nikcli, "ok")
    expect(p.requests[1]!.message).toContain("chiave o un token")
    expect(p.requests[1]!.message.endsWith("ok")).toBe(true)
    await p.done()
    p.turns.send(nikcli, "ancora")
    expect(p.requests[2]!.message).toBe("ancora")
  })
})
