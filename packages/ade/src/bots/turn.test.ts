import { afterEach, describe, expect, test } from "bun:test"
import { t } from "../i18n"
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
    spawned: () => exits.length,
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

  /* B8d: a bot's ragu turn runs on ADE's server, with its session's rules; nothing here would carry them. */
  test("a ragu turn is not started here", async () => {
    const m = machine()
    const result = await runTurn({ runner: "ragu", message: "ciao" }, m.deps).result
    expect(result.status).toBe("error")
    expect(result.problem).toBe(t("bots.turn.raguOnServer"))
    expect(m.spawned()).toBe(0)
    expect(turnsRunning("ragu")).toBe(0)
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
      spawn: async (options: {
        onExit: (code: number | null) => void
        onLine: (line: string, stream: "out" | "err") => void
      }) => {
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
  test("Claude in abbonamento toglie le chiavi ereditate e non ne passa", async () => {
    const seen: { flags?: readonly string[]; secrets?: readonly string[] }[] = []
    let exit: (code: number | null) => void = () => {}
    const host = {
      spawn: async (options: {
        flags?: readonly string[]
        secrets?: readonly string[]
        onExit: (code: number | null) => void
      }) => {
        seen.push({
          ...(options.flags ? { flags: options.flags } : {}),
          ...(options.secrets ? { secrets: options.secrets } : {}),
        })
        exit = options.onExit
        return { kill: () => {}, write: () => {}, resize: () => {} }
      },
    }
    const deps: TurnDeps = { host: async () => host as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>> }
    const turn = runTurn({ runner: "claude", message: "ciao", exitGraceMs: 30 }, deps)
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    exit(0)
    await turn.result
    expect(seen[0]!.flags).toEqual(["account-plan"])
    expect(seen[0]!.secrets).toBeUndefined()
  })

  test("una chiave tolta fallisce il turno e non parte in abbonamento", async () => {
    const seen: { flags?: readonly string[]; secrets?: readonly string[] }[] = []
    const host = {
      spawn: async (options: { flags?: readonly string[]; secrets?: readonly string[] }) => {
        seen.push({
          ...(options.flags ? { flags: options.flags } : {}),
          ...(options.secrets ? { secrets: options.secrets } : {}),
        })
        throw new Error("chiave «finta» non assegnata a claude-code in Impostazioni › Chiavi API")
      },
    }
    const deps: TurnDeps = { host: async () => host as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>> }
    const result = await runTurn({ runner: "claude", message: "ciao", account: { mode: "key", key: "finta" } }, deps)
      .result
    expect(seen[0]!.flags).toEqual(["account-key"])
    expect(seen[0]!.flags).not.toContain("account-plan")
    expect(seen[0]!.secrets).toEqual(["finta"])
    expect(result.status).toBe("error")
    expect(result.problem).toContain("chiave «finta» non assegnata a claude-code")
    expect(result.problem).not.toContain("sk-")
  })
})

/*
 * Scelta 7 per Codex: da chat e nelle routine i server MCP del config.toml dell'utente si spengono per nome, letti dal
 * file; il resto del file (un provider, i profili) resta. Se il file non si legge, il turno lo lascia fuori tutto, e un
 * errore lo dice.
 */
describe("a Codex turn nobody watches reads the user's MCP servers", () => {
  const CONFIG = "C:/Users/u/.codex/config.toml"

  function codexMachine(
    config: { text?: string; unreadable?: boolean; version?: string | null } = {},
    others: readonly string[] = [],
  ) {
    const argv: (readonly string[])[] = []
    let versionAsked = 0
    const exits: ((code: number | null) => void)[] = []
    const lines: ((line: string) => void)[] = []
    const reads: string[] = []
    const host = {
      homeDir: async () => "C:/Users/u",
      exists: async (path: string) =>
        path === CONFIG ? config.text !== undefined || config.unreadable === true : others.includes(path),
      readTextFile: async (path: string) => {
        reads.push(path)
        if (config.unreadable) throw new Error("accesso negato")
        return { text: config.text ?? "", truncated: false, bytes: (config.text ?? "").length }
      },
      spawn: async (options: {
        args?: readonly string[]
        onExit: (code: number | null) => void
        onLine: (line: string) => void
      }) => {
        argv.push(options.args ?? [])
        exits.push(options.onExit)
        lines.push(options.onLine)
        return { kill: () => {}, write: () => {}, resize: () => {} }
      },
    }
    const deps: TurnDeps = {
      host: async () => host as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>>,
      codexVersion: async () => {
        versionAsked++
        return config.version === undefined ? "codex-cli 0.162.1" : config.version
      },
    }
    return {
      deps,
      argv,
      reads,
      exit: (code: number | null) => exits.at(-1)?.(code),
      say: (line: string) => lines.at(-1)?.(line),
      spawned: () => argv.length,
      versionAsked: () => versionAsked,
    }
  }

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 1))
  }

  test("each server named in ~/.codex/config.toml is switched off by name, and the file is kept", async () => {
    const m = codexMachine({
      text: '[mcp_servers.docs]\nurl = "https://example.com"\n[mcp_servers.git]\ncommand = "x"\n',
    })
    const turn = runTurn({ runner: "codex", message: "ciao", remote: { commands: false } }, m.deps)
    await until(() => m.spawned() > 0)
    expect(m.argv[0]).toContain("mcp_servers.docs.enabled=false")
    expect(m.argv[0]).toContain("mcp_servers.git.enabled=false")
    expect(m.argv[0]).not.toContain("--ignore-user-config")
    m.exit(0)
    await turn.result
  })

  test("no config.toml: nothing to switch off, nothing left out", async () => {
    const m = codexMachine()
    const turn = runTurn({ runner: "codex", message: "ciao", unattended: true }, m.deps)
    await until(() => m.spawned() > 0)
    expect(m.argv[0]).not.toContain("--ignore-user-config")
    expect(m.argv[0]!.join(" ")).not.toContain("mcp_servers.")
    expect(m.argv[0]).toContain('web_search="disabled"')
    m.exit(0)
    await turn.result
  })

  test("a config.toml that cannot be read: the whole file is left out, and a failure says so", async () => {
    const m = codexMachine({ unreadable: true })
    const turn = runTurn({ runner: "codex", message: "ciao", remote: { commands: false } }, m.deps)
    await until(() => m.spawned() > 0)
    expect(m.argv[0]).toContain("--ignore-user-config")
    m.say("Error: model_provider `azure` not found")
    m.exit(1)
    const result = await turn.result
    expect(result.status).toBe("error")
    expect(result.problem).toContain(t("bots.codex.withoutUserConfig"))
  })

  test("a Codex that refuses the options says why, and to update it", async () => {
    const m = codexMachine({ text: '[mcp_servers.docs]\nurl = "x"\n' })
    const turn = runTurn({ runner: "codex", message: "ciao", remote: { commands: false } }, m.deps)
    await until(() => m.spawned() > 0)
    m.say("Error loading config.toml: unknown field `enabled`")
    m.exit(1)
    const result = await turn.result
    expect(result.problem).toContain(t("bots.codex.optionsRefused"))
  })

  /*
   * bot-lettura-3: a Codex older than 0.131.0 does not read the project-only profile, and would run with the read-only
   * sandbox, which reads the whole disk. Such a turn, or one whose version could not be read, does not start.
   */
  test("a Codex too old for the project-only profile: the turn does not start, and says which version it needs", async () => {
    const m = codexMachine({ text: '[mcp_servers.docs]\nurl = "x"\n', version: "codex-cli 0.130.0" })
    const result = await runTurn({ runner: "codex", message: "ciao", remote: { commands: false } }, m.deps).result
    expect(result.status).toBe("error")
    expect(result.problem).toContain(t("bots.codex.tooOld", "0.131.0", "0.130.0"))
    expect(m.spawned()).toBe(0)
  })

  test("a Codex whose version could not be read: the routine does not start either", async () => {
    const m = codexMachine({ version: null })
    const result = await runTurn({ runner: "codex", message: "ciao", unattended: true }, m.deps).result
    expect(result.status).toBe("error")
    expect(result.problem).toContain(t("bots.codex.versionUnknown"))
    expect(m.spawned()).toBe(0)
  })

  test("in the panel the version is not asked, and a recent Codex from a chat starts", async () => {
    const panel = codexMachine({ version: "codex-cli 0.100.0" })
    const turn = runTurn({ runner: "codex", message: "ciao" }, panel.deps)
    await until(() => panel.spawned() > 0)
    expect(panel.versionAsked()).toBe(0)
    panel.exit(0)
    await turn.result
    const chat = codexMachine()
    const remote = runTurn({ runner: "codex", message: "ciao", remote: { commands: false } }, chat.deps)
    await until(() => chat.spawned() > 0)
    expect(chat.versionAsked()).toBe(1)
    chat.exit(0)
    await remote.result
  })

  /*
   * bot-lettura-2: from a chat Codex starts only with a sandbox that reads the project alone. Windows' `unelevated`
   * fallback cannot hold it, and Codex stops before any model call with this line (codex-cli 0.162.1, fake provider).
   * The turn says it did not start and how to get a sandbox that can, and is not tried again with a wider one.
   */
  test("a sandbox that cannot keep reads in the project: the turn says why, and is not retried", async () => {
    const m = codexMachine({ text: '[mcp_servers.docs]\nurl = "x"\n' })
    const turn = runTurn({ runner: "codex", message: "ciao", remote: { commands: false } }, m.deps)
    await until(() => m.spawned() > 0)
    m.say(
      "Error: thread/start: thread/start failed: error creating thread: failed to load AGENTS.md instructions for environment `local`: failed to prepare fs sandbox: failed to prepare windows sandbox wrapper: windows unelevated restricted-token sandbox cannot enforce split filesystem read restrictions directly; refusing to run unsandboxed (code -32603)",
    )
    m.exit(1)
    const result = await turn.result
    expect(result.status).toBe("error")
    expect(result.problem).toContain(t("bots.codex.sandboxCannotRead"))
    expect(result.problem).not.toContain(t("bots.codex.optionsRefused"))
    expect(m.spawned()).toBe(1)
  })

  /*
   * Codex 0.162.1 reads a project's `.codex/config.toml` too, in a trusted project, from its git root down to the
   * turn's folder (checked with `codex mcp list` and a fake provider, no model turn). A server switched off by name in
   * a project Codex does not trust stops the turn (`invalid transport`), and ADE cannot see the trust: with such a
   * file the turn leaves the user's config out, and the list of trusted projects with it, so the project's is not
   * read either (0 servers, checked the same way).
   */
  test("a project's .codex/config.toml, in the turn's folder or above it: the user's config is left out", async () => {
    for (const project of ["C:/Users/u/progetto/.codex/config.toml", "C:/Users/u/progetto/app/.codex/config.toml"]) {
      const m = codexMachine({ text: '[mcp_servers.docs]\nurl = "x"\n' }, [project])
      const turn = runTurn(
        { runner: "codex", message: "ciao", cwd: "C:\\Users\\u\\progetto\\app", remote: { commands: false } },
        m.deps,
      )
      await until(() => m.spawned() > 0)
      expect([project, m.argv[0]!.includes("--ignore-user-config")]).toEqual([project, true])
      expect(m.argv[0]!.join(" ")).not.toContain("mcp_servers.")
      m.say("Error: model_provider `azure` not found")
      m.exit(1)
      expect((await turn.result).problem).toContain(t("bots.codex.projectConfig"))
    }
  })

  test("the user's own ~/.codex is not taken for a project's, from a folder under home", async () => {
    const m = codexMachine({ text: '[mcp_servers.docs]\nurl = "x"\n' })
    const turn = runTurn({ runner: "codex", message: "ciao", cwd: "C:/Users/u/progetto", unattended: true }, m.deps)
    await until(() => m.spawned() > 0)
    expect(m.argv[0]).toContain("mcp_servers.docs.enabled=false")
    expect(m.argv[0]).not.toContain("--ignore-user-config")
    m.exit(0)
    await turn.result
  })

  test("a turn in the panel does not read the file and keeps Codex as the user set it", async () => {
    const m = codexMachine({ text: '[mcp_servers.docs]\nurl = "x"\n' })
    const turn = runTurn({ runner: "codex", message: "ciao" }, m.deps)
    await until(() => m.spawned() > 0)
    expect(m.reads).toEqual([])
    expect(m.argv[0]!.join(" ")).not.toContain("mcp_servers.")
    expect(m.argv[0]).not.toContain('web_search="disabled"')
    m.exit(0)
    await turn.result
  })
})
