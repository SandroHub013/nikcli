import { describe, expect, test } from "bun:test"
import type { AgentFile } from "./nikcli"
import { createBotTurns } from "./controller"
import { acquireTurn, turnsRunning } from "./terms"
import { emptyTalk, type Talk } from "./talk"
import { runTurn, type TurnDeps } from "./turn"

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
  const host = {
    spawn: async (spawn: {
      flags?: readonly string[]
      secrets?: readonly string[]
      onExit: (code: number | null) => void
      onLine: (line: string, stream: "out" | "err") => void
    }) => {
      exits.push(spawn.onExit)
      lines.push(spawn.onLine)
      flags.push(spawn.flags)
      secrets.push(spawn.secrets)
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
    exit: (code: number | null, at = exits.length - 1) => exits[at]?.(code),
    say: (line: string, at = lines.length - 1) => lines[at]?.(line, "out"),
  }
}

function panel(m: ReturnType<typeof machine>, accountOf?: (path: string) => { mode: "plan" } | { mode: "key"; key: string }) {
  const talks: Record<string, Talk> = {}
  const turns = createBotTurns({
    runTurn: (request) => runTurn(request, m.deps),
    talkOf: (path) => talks[path] ?? emptyTalk(),
    update: (path, change) => {
      talks[path] = change(talks[path] ?? emptyTalk())
    },
    ...(accountOf ? { accountOf } : {}),
  })
  return { turns, talk: (path: string) => talks[path] ?? emptyTalk() }
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

  test("the permission answer goes to the running process", async () => {
    const m = machine()
    const p = panel(m)
    const nikcli = bot("nikcli")
    p.turns.send(nikcli, "ciao")
    await tick()
    p.turns.answer(nikcli, "once")
    expect(m.writes.length).toBe(1)
    p.turns.stop(nikcli)
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
