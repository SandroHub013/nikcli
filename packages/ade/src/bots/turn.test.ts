import { afterEach, describe, expect, test } from "bun:test"
import { MAX_PARALLEL_TURNS, turnsRunning } from "./terms"
import { runTurn, timeoutProblem, TURN_EXIT_GRACE_MS, TURN_TIMEOUT_MS, type Turn, type TurnDeps } from "./turn"

/*
 * A turn against a fake machine: `spawn` records what it was asked and hands
 * back a session whose exit the test controls. Until `exit` is called the CLI
 * is "running", which is what a hung turn looks like from here.
 */
function machine() {
  const kills: { tree?: boolean }[] = []
  const exits: ((code: number | null) => void)[] = []
  const lines: ((line: string) => void)[] = []
  const host = {
    spawn: async (options: { onExit: (code: number | null) => void; onLine: (line: string) => void }) => {
      exits.push(options.onExit)
      lines.push(options.onLine)
      return {
        // A killed session unlistens and never reports its exit, as `host/shell.ts` does.
        kill: (options?: { tree?: boolean }) => void kills.push(options ?? {}),
        write: () => {},
        resize: () => {},
      }
    },
  }
  const deps: TurnDeps = { host: async () => host as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>> }
  return {
    deps,
    kills,
    exit: (code: number | null, at = exits.length - 1) => exits[at]?.(code),
    say: (line: string, at = lines.length - 1) => lines[at]?.(line),
  }
}

const open: Turn[] = []
afterEach(async () => {
  for (const turn of open.splice(0)) {
    turn.stop()
    await turn.result
  }
})
const start = (m: ReturnType<typeof machine>, timeoutMs?: number) => {
  const turn = runTurn({ runner: "claude", message: "ciao", ...(timeoutMs ? { timeoutMs } : {}) }, m.deps)
  open.push(turn)
  return turn
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("runTurn", () => {
  test("a turn that runs past its time is stopped with its children and says so", async () => {
    const m = machine()
    const result = await start(m, 30).result
    expect(result.status).toBe("error")
    expect(result.problem).toBe(timeoutProblem("Claude Code", 30))
    expect(m.kills).toEqual([{ tree: true }])
    expect(turnsRunning("claude")).toBe(0)
  })

  test("the limit is five minutes unless the request says otherwise, and is said plainly", () => {
    expect(TURN_TIMEOUT_MS).toBe(300_000)
    expect(TURN_EXIT_GRACE_MS).toBe(10_000)
    expect(timeoutProblem("Codex", TURN_TIMEOUT_MS)).toBe("Codex non ha finito il turno in 5 minuti: l'ho fermato.")
    expect(timeoutProblem("Codex", 60_000)).toBe("Codex non ha finito il turno in 1 minuto: l'ho fermato.")
    expect(timeoutProblem("Codex", 90_000)).toBe("Codex non ha finito il turno in 90 secondi: l'ho fermato.")
  })

  test("stop ends the wait even though a killed session reports no exit", async () => {
    const m = machine()
    const turn = start(m)
    await tick()
    turn.stop()
    const result = await turn.result
    expect(result.status).toBe("stopped")
    expect(m.kills).toEqual([{ tree: true }])
    expect(turnsRunning("claude")).toBe(0)
  })

  test("the turn is over at Claude Code's result, without waiting for the process to exit", async () => {
    const m = machine()
    const turn = start(m)
    await tick()
    m.say(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Tre sessioni aperte." }] } }))
    m.say(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Tre sessioni aperte." }))
    const result = await turn.result
    expect(result.status).toBe("done")
    expect(result.text).toBe("Tre sessioni aperte.")
    expect(m.kills).toEqual([])
    expect(turnsRunning("claude")).toBe(0)
    // The exit arriving afterwards changes nothing.
    m.exit(0)
  })

  test("a CLI that does not exit after its result is killed with its children", async () => {
    const m = machine()
    const turn = runTurn({ runner: "claude", message: "ciao", exitGraceMs: 30 }, m.deps)
    await tick()
    m.say(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Fatto." }))
    expect((await turn.result).status).toBe("done")
    expect(m.kills).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(m.kills).toEqual([{ tree: true }])
  })

  test("a CLI that exits within the grace after its result is left alone", async () => {
    const m = machine()
    const turn = runTurn({ runner: "claude", message: "ciao", exitGraceMs: 30 }, m.deps)
    await tick()
    m.say(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Fatto." }))
    await turn.result
    m.exit(0)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(m.kills).toEqual([])
  })

  test("a turn that exits on its own is done and kills nothing", async () => {
    const m = machine()
    const turn = start(m)
    await tick()
    m.exit(0)
    expect((await turn.result).status).toBe("done")
    expect(m.kills).toEqual([])
  })

  test("a CLI that fails says why: its last plain line goes with the exit code (review B7, BASSO 3)", async () => {
    const m = machine()
    const turn = runTurn({ runner: "codex", message: "ciao" }, m.deps)
    open.push(turn)
    await tick()
    m.say("Reading additional input from stdin...")
    m.say('Error: approval_policy = "untrusted" is no longer supported; remove this setting')
    m.exit(1)
    const result = await turn.result
    expect(result.exitCode).toBe(1)
    expect(result.talk.messages.at(-1)?.text).toBe(
      'Codex è uscito con codice 1: Error: approval_policy = "untrusted" is no longer supported; remove this setting',
    )
  })

  test("a nikcli turn is over at its own last step, and gives its slot back (B7)", async () => {
    const m = machine()
    const turn = runTurn({ runner: "nikcli", message: "ciao" }, m.deps)
    open.push(turn)
    await tick()
    m.say('{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}')
    m.say('{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"GLOBALE"}}')
    m.say('{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","reason":"stop","tokens":{"input":10,"output":1},"cost":0}}')
    const result = await turn.result
    expect(result.status).toBe("done")
    expect(result.text).toContain("GLOBALE")
    expect(result.sessionId).toBe("ses_1")
    expect(turnsRunning("nikcli")).toBe(0)
  })

  test("the plan's parallel-turn cap holds for turns, and a finished one frees its slot", async () => {
    const m = machine()
    const running = Array.from({ length: MAX_PARALLEL_TURNS }, () => start(m))
    await tick()
    expect(turnsRunning("claude")).toBe(MAX_PARALLEL_TURNS)

    const refused = await start(m).result
    expect(refused.status).toBe("error")
    expect(refused.problem).toBeTruthy()

    running[0]!.stop()
    await running[0]!.result
    const next = start(m)
    await tick()
    expect(turnsRunning("claude")).toBe(MAX_PARALLEL_TURNS)
    m.exit(0)
    expect((await next.result).status).toBe("done")
  })
})

/*
 * From ade/voice-0.6.0 (3e04e88dd), the same fix found in the voice trial:
 * spoken questions cut short by newer ones used to leak a slot each.
 */
describe("bots/turn, stopped by newer questions", () => {
  test("four stopped turns in a row each end and give their slot back", async () => {
    const m = machine()
    for (let i = 0; i < 4; i++) {
      const turn = runTurn({ runner: "claude", message: `domanda ${i}` }, m.deps)
      await tick()
      turn.stop()
      expect((await turn.result).status).toBe("stopped")
    }
    expect(m.kills).toHaveLength(4)
    expect(turnsRunning("claude")).toBe(0)
  })

  test("a turn stopped before its process started is killed as soon as it starts, and ends", async () => {
    const m = machine()
    const turn = runTurn({ runner: "claude", message: "subito fermata" }, m.deps)
    turn.stop()
    expect((await turn.result).status).toBe("stopped")
    expect(m.kills).toEqual([{ tree: true }])
    expect(turnsRunning("claude")).toBe(0)
  })
})

/*
 * B2 (audit A3): the host reports a CLI it could not start as an "err" line
 * and an exit, then returns a session anyway. The turn ended «done» with
 * nothing said, and the voice read out nothing.
 */
describe("a CLI that does not start", () => {
  test("ends the turn in error with the host's reason, and gives the place back", async () => {
    const host = {
      spawn: async (options: { onExit: (code: number | null) => void; onLine: (line: string, stream: "out" | "err") => void }) => {
        options.onLine("comando non consentito: codex", "err")
        options.onExit(null)
        return { kill: () => {}, write: () => {}, resize: () => {} }
      },
    }
    const deps: TurnDeps = { host: async () => host as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>> }
    const result = await runTurn({ runner: "codex", message: "ciao" }, deps).result
    expect(result.status).toBe("error")
    expect(result.problem).toBe("Codex non si avvia: comando non consentito: codex")
    expect(result.exitCode).toBeUndefined()
    expect(turnsRunning("codex")).toBe(0)
  })
})

describe("le opzioni di avvio arrivano all'host", () => {
  test("un bot dell'utente su nikcli parte con no-project-config", async () => {
    const seen: { flags?: readonly string[] }[] = []
    let exit: (code: number | null) => void = () => {}
    const host = {
      spawn: async (options: { flags?: readonly string[]; onExit: (code: number | null) => void }) => {
        seen.push({ ...(options.flags ? { flags: options.flags } : {}) })
        exit = options.onExit
        return { kill: () => {}, write: () => {}, resize: () => {} }
      },
    }
    const deps: TurnDeps = { host: async () => host as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>> }
    const turn = runTurn({ runner: "nikcli", message: "ciao", exitGraceMs: 30 }, deps)
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    exit(0)
    await turn.result
    expect(seen[0]!.flags).toEqual(["no-project-config"])
  })
})
