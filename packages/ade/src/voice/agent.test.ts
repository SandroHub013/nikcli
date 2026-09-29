import { describe, expect, test } from "bun:test"
import type { AgentStatus } from "../session-new/availability"
import { createWorkbench } from "../surface/state"
import { createAdeVoiceHost } from "./host"
import type { TurnRequest, TurnResult } from "../bots/turn"
import { limitNotice } from "../bots/terms"
import { setLocalePreference, resetLocaleForTests } from "../i18n/locale"
import { runnerById, turnCommand } from "../bots/runners"
import {
  createVoiceAgent,
  resolveVoiceAgentRunner,
  VOICE_AGENT_DISABLED_TOOLS,
  VOICE_AGENT_FAST,
  VOICE_AGENT_INSTRUCTIONS,
  VOICE_AGENT_TIMEOUT_MS,
  VOICE_PLAN_SESSION_PHRASES,
  VOICE_PLAN_TIMEOUT_MS,
} from "./agent"
import { PLANNER_SYSTEM } from "@nikcli-ai/voice/core"
import { isFreeModel } from "../bots/runners"

const status = (id: string, availability: AgentStatus["availability"]): AgentStatus =>
  ({ agent: { id, label: id, command: id }, availability }) as AgentStatus

function fakeRunner(results: Partial<TurnResult>[]) {
  const requests: TurnRequest[] = []
  let stops = 0
  const runTurn = (request: TurnRequest) => {
    requests.push(request)
    const next = results.shift() ?? {}
    return {
      result: Promise.resolve({
        status: "done",
        text: "",
        tokens: 0,
        costUsd: 0,
        talk: {} as never,
        ...next,
      } as TurnResult),
      stop: () => stops++,
    }
  }
  return { runTurn, requests, stops: () => stops }
}

describe("voice/agent", () => {
  test("auto takes the first installed CLI, in subscription order", () => {
    expect(resolveVoiceAgentRunner("auto", [status("claude-code", "assente"), status("codex", "presente")])).toEqual({
      runner: "codex",
    })
    expect(resolveVoiceAgentRunner("auto", undefined)).toEqual({ runner: "claude" })
    expect(resolveVoiceAgentRunner("codex", [status("codex", "assente")])).toEqual({ runner: "codex" })
    const none = resolveVoiceAgentRunner(
      "auto",
      ["claude-code", "codex", "nikcli"].map((id) => status(id, "assente")),
    )
    expect("problem" in none && none.problem).toContain("Claude Code")
    // nikcli cannot be held to read-only for one turn: never picked, and refused when named.
    expect(
      resolveVoiceAgentRunner("auto", [
        status("claude-code", "assente"),
        status("codex", "assente"),
        status("nikcli", "presente"),
      ]),
    ).toHaveProperty("problem")
    expect(resolveVoiceAgentRunner("nikcli", undefined)).toHaveProperty("problem")
  })

  test("a voice turn is read-only: no edits, no writes, no shell but ade-msg, no web", async () => {
    const runner = fakeRunner([{}])
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => "C:/p" })
    await agent.ask({ text: "x", engine: "claude" })
    expect(runner.requests[0].disabledTools).toEqual(["edit", "write", "bash", "webfetch", "websearch"])
    expect(runner.requests[0].disabledTools).toBe(VOICE_AGENT_DISABLED_TOOLS)
  })

  test("a voice turn gets 150 s: past the 110 s of a blocking ade-msg ask, well short of five minutes", async () => {
    const runner = fakeRunner([{}])
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => "C:/p" })
    await agent.ask({ text: "x", engine: "claude" })
    expect(runner.requests[0].timeoutMs).toBe(VOICE_AGENT_TIMEOUT_MS)
    expect(VOICE_AGENT_TIMEOUT_MS).toBe(150_000)
  })

  test("a stopped turn that ends after the newer one does not take its conversation", async () => {
    const pending: ((result: Partial<TurnResult>) => void)[] = []
    const requests: TurnRequest[] = []
    const runTurn = (request: TurnRequest) => {
      requests.push(request)
      return {
        result: new Promise<TurnResult>((resolve) =>
          pending.push((next) =>
            resolve({ status: "done", text: "", tokens: 0, costUsd: 0, talk: {} as never, ...next } as TurnResult),
          ),
        ),
        stop: () => {},
      }
    }
    const agent = createVoiceAgent({ runTurn, statuses: () => undefined, cwd: () => "C:/p" })

    const first = agent.ask({ text: "uno", engine: "claude" })
    const second = agent.ask({ text: "due", engine: "claude" })
    pending[1]!({ text: "nuova", sessionId: "new" })
    await second
    pending[0]!({ status: "stopped", sessionId: "old" })
    await first

    void agent.ask({ text: "tre", engine: "claude" })
    expect(requests[2]!.sessionId).toBe("new")
  })

  test("the fast setting asks Claude Code for Sonnet 5.5 with little effort, and cli leaves the CLI alone", async () => {
    const runner = fakeRunner([{ text: "a" }, { text: "b" }, { text: "c" }])
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => "C:/p" })
    await agent.ask({ text: "ciao", engine: "claude", speed: "fast" })
    await agent.ask({ text: "ciao", engine: "codex", speed: "fast" })
    await agent.ask({ text: "ciao", engine: "claude", speed: "cli" })
    expect(runner.requests[0]).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" })
    expect(VOICE_AGENT_FAST.claude).toEqual({ model: "claude-sonnet-5-5", effort: "low" })
    expect(runner.requests[1]!.model).toBeUndefined()
    expect(runner.requests[1]!.effort).toBe("low")
    expect(runner.requests[2]!.model).toBeUndefined()
    expect(runner.requests[2]!.effort).toBeUndefined()
  })

  test("the answer is passed on as it is written, only when it grows", async () => {
    const requests: TurnRequest[] = []
    const talk = (streaming: string) => ({ messages: [], status: "running", tokens: 0, costUsd: 0, streaming }) as never
    const runTurn = (request: TurnRequest) => {
      requests.push(request)
      request.onUpdate?.(talk("Ci sono"))
      request.onUpdate?.(talk("Ci sono"))
      request.onUpdate?.(talk("Ci sono due sessioni."))
      return {
        result: Promise.resolve({
          status: "done",
          text: "Ci sono due sessioni.",
          tokens: 0,
          costUsd: 0,
          talk: {} as never,
        } as TurnResult),
        stop: () => {},
      }
    }
    const agent = createVoiceAgent({ runTurn, statuses: () => undefined, cwd: () => "C:/p" })
    const heard: string[] = []
    await agent.ask({ text: "quante sessioni?", engine: "claude", onText: (soFar) => heard.push(soFar) })
    expect(requests[0]!.partial).toBe(true)
    expect(heard).toEqual(["Ci sono", "Ci sono due sessioni."])
    // Claude Code is always asked for pieces: a warm process is started before anyone listens.
    await agent.ask({ text: "quante sessioni?", engine: "codex" })
    expect(requests[1]!.partial).toBe(false)
  })

  test("a turn carries the instructions, the project and an ade-msg identity, and continues the conversation", async () => {
    const runner = fakeRunner([
      { text: "Ci sono due sessioni.", sessionId: "s1" },
      { text: "La seconda lavora sui test." },
    ])
    let cwd = "C:/p"
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => cwd })

    expect(await agent.ask({ text: "quante sessioni ci sono?", engine: "claude" })).toEqual({
      ok: true,
      text: "Ci sono due sessioni.",
      ran: true,
    })
    await agent.ask({ text: "e la seconda?", engine: "claude" })

    expect(runner.requests[0]).toMatchObject({ runner: "claude", cwd: "C:/p", mailbox: { id: "voce" }, lean: true })
    expect(runner.requests[0].instructions).toBe(VOICE_AGENT_INSTRUCTIONS)
    expect(runner.requests[0].sessionId).toBeUndefined()
    expect(runner.requests[1].sessionId).toBe("s1")

    // Another project, or another engine, starts over.
    cwd = "C:/other"
    await agent.ask({ text: "e ora?", engine: "claude" })
    expect(runner.requests[2].sessionId).toBeUndefined()
  })

  test("failures come back as sentences, and an abort stops the turn", async () => {
    const runner = fakeRunner([{ status: "error", problem: "claude non si avvia: ENOENT" }, { status: "stopped" }])
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => undefined })

    expect(await agent.ask({ text: "x", engine: "claude" })).toEqual({
      ok: false,
      text: "claude non si avvia: ENOENT",
      ran: true,
    })
    // No runner at all: nothing ran, so the planner may still take the sentence.
    expect(await agent.ask({ text: "x", engine: "nikcli" })).toMatchObject({ ok: false, ran: false })

    const abort = new AbortController()
    const pending = agent.ask({ text: "y", engine: "claude", signal: abort.signal })
    abort.abort()
    expect((await pending).ok).toBe(false)
    expect(runner.stops()).toBe(1)
  })

  test("the plan's limit is recognised with English active, without the Italian sentence", async () => {
    setLocalePreference("en")
    try {
      const notice = limitNotice("Claude Code")
      expect(notice).toContain("does not retry")
      expect(notice).not.toContain("non riprova")
      const runner = fakeRunner([
        { status: "error", problem: notice, limited: true, talk: { limited: true } as never },
        { status: "done", text: "Two sessions." },
      ])
      const agent = createVoiceAgent({
        runTurn: runner.runTurn,
        statuses: () => [status("claude-code", "presente"), status("codex", "presente")],
        cwd: () => "C:/p",
        codexFallback: () => true,
      })
      const answer = await agent.ask({ text: "how many sessions?", engine: "auto" })
      expect(runner.requests.map((request) => request.runner)).toEqual(["claude", "codex"])
      expect(answer.ok).toBe(true)
      expect(answer.text).toContain("Two sessions.")
    } finally {
      resetLocaleForTests()
    }
  })

  test("a later successful turn is not a plan limit, and an unrelated 'does not retry' is not either", async () => {
    const limit = fakeRunner([
      { status: "error", problem: limitNotice("Claude Code"), limited: true },
      { status: "done", text: "Fatto.", limited: undefined, talk: { messages: [] } as never },
    ])
    const agent = createVoiceAgent({
      runTurn: limit.runTurn,
      statuses: () => [status("claude-code", "presente"), status("codex", "presente")],
      cwd: () => "C:/p",
      codexFallback: () => true,
    })
    await agent.ask({ text: "prima", engine: "claude" })
    const second = await agent.ask({ text: "dopo", engine: "claude" })
    expect(second).toMatchObject({ ok: true, text: "Fatto." })
    expect(second.text).not.toContain("limite")

    const unrelated = fakeRunner([{ status: "error", problem: "the client does not retry this request" }])
    const again = createVoiceAgent({
      runTurn: unrelated.runTurn,
      statuses: () => [status("claude-code", "presente"), status("codex", "presente")],
      cwd: () => "C:/p",
      codexFallback: () => true,
    })
    const answer = await again.ask({ text: "x", engine: "auto" })
    expect(unrelated.requests).toHaveLength(1)
    expect(answer.text).toContain("does not retry")
  })

  test("a turn ended by the plan's limit is said as the bots say it, and never asked again", async () => {
    const runner = fakeRunner([{ status: "error", problem: limitNotice("Claude Code") }])
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => "C:/p" })

    const answer = await agent.ask({ text: "quante sessioni ci sono?", engine: "claude" })
    // `ran`: a turn did start, so the planner does not take the sentence over either.
    expect(answer).toEqual({ ok: false, text: limitNotice("Claude Code"), ran: true })
    expect(answer.text).toContain("ADE non riprova")
    // Neither the same CLI again nor another engine: one sentence, one turn.
    expect(runner.requests).toHaveLength(1)
  })

  describe("M4: fallback to Codex on limit in auto mode", () => {
    test("when codexFallback is off (default), reports limit and does not call Codex", async () => {
      const runner = fakeRunner([{ status: "error", problem: limitNotice("Claude Code") }])
      const agent = createVoiceAgent({
        runTurn: runner.runTurn,
        statuses: () => [status("claude-code", "presente"), status("codex", "presente")],
        cwd: () => "C:/p",
      })

      const answer = await agent.ask({ text: "quante sessioni ci sono?", engine: "auto" })
      expect(runner.requests).toHaveLength(1)
      expect(runner.requests[0].runner).toBe("claude")
      expect(answer.ok).toBe(false)
      expect(answer.text).toBe(limitNotice("Claude Code"))
      expect(answer.text).toContain("ADE non riprova")
      expect(answer.ran).toBe(true)
    })

    test("when codexFallback is explicitly false, reports limit and does not call Codex", async () => {
      const runner = fakeRunner([{ status: "error", problem: limitNotice("Claude Code") }])
      const agent = createVoiceAgent({
        runTurn: runner.runTurn,
        statuses: () => [status("claude-code", "presente"), status("codex", "presente")],
        cwd: () => "C:/p",
        codexFallback: () => false,
      })

      const answer = await agent.ask({ text: "quante sessioni ci sono?", engine: "auto" })
      expect(runner.requests).toHaveLength(1)
      expect(runner.requests[0].runner).toBe("claude")
      expect(answer.ok).toBe(false)
      expect(answer.text).toBe(limitNotice("Claude Code"))
      expect(answer.ran).toBe(true)
    })

    test("in auto mode when codexFallback is on and Claude hits limit, repeats once with Codex and announces it", async () => {
      const runner = fakeRunner([
        { status: "error", problem: limitNotice("Claude Code") },
        { status: "done", text: "Ci sono due sessioni attive." },
      ])
      const agent = createVoiceAgent({
        runTurn: runner.runTurn,
        statuses: () => [status("claude-code", "presente"), status("codex", "presente")],
        cwd: () => "C:/p",
        codexFallback: () => true,
      })

      const answer = await agent.ask({ text: "quante sessioni ci sono?", engine: "auto" })
      expect(runner.requests).toHaveLength(2)
      expect(runner.requests[0].runner).toBe("claude")
      expect(runner.requests[1].runner).toBe("codex")
      expect(answer).toEqual({
        ok: true,
        text: "Claude è al limite: rispondo con Codex. Ci sono due sessioni attive.",
        ran: true,
      })
    })

    test("in auto mode when Claude hits limit and Codex is missing, says so clearly without retrying", async () => {
      const runner = fakeRunner([{ status: "error", problem: "Claude AI usage limit reached|1757880000" }])
      const agent = createVoiceAgent({
        runTurn: runner.runTurn,
        statuses: () => [status("claude-code", "presente"), status("codex", "assente")],
        cwd: () => "C:/p",
        codexFallback: () => true,
      })

      const answer = await agent.ask({ text: "quante sessioni ci sono?", engine: "auto" })
      expect(runner.requests).toHaveLength(1)
      expect(answer).toEqual({
        ok: false,
        text: "Claude è al limite del piano e Codex non è disponibile.",
        ran: true,
      })
    })

    test("in auto mode when Claude hits limit and Codex also fails, reports failure and does not retry", async () => {
      const runner = fakeRunner([
        { status: "error", problem: limitNotice("Claude Code") },
        { status: "error", problem: "Codex non si avvia: ENOENT" },
      ])
      const agent = createVoiceAgent({
        runTurn: runner.runTurn,
        statuses: () => [status("claude-code", "presente"), status("codex", "presente")],
        cwd: () => "C:/p",
        codexFallback: () => true,
      })

      const answer = await agent.ask({ text: "quante sessioni ci sono?", engine: "auto" })
      expect(runner.requests).toHaveLength(2)
      expect(answer.ok).toBe(false)
      expect(answer.text).toContain("Claude è al limite e anche Codex non è riuscito a rispondere")
      expect(answer.text).toContain("Codex non si avvia")
      expect(answer.ran).toBe(true)
    })

    test("manual agent choice does not fallback on limit", async () => {
      const runner = fakeRunner([{ status: "error", problem: limitNotice("Claude Code") }])
      const agent = createVoiceAgent({
        runTurn: runner.runTurn,
        statuses: () => [status("claude-code", "presente"), status("codex", "presente")],
        cwd: () => "C:/p",
        codexFallback: () => true,
      })

      const answer = await agent.ask({ text: "quante sessioni ci sono?", engine: "claude" })
      expect(runner.requests).toHaveLength(1)
      expect(answer.ok).toBe(false)
      expect(answer.text).toContain("ADE non riprova")
    })

    test("in auto mode fallback streams updates with prefix", async () => {
      const talk = (streaming: string) =>
        ({ messages: [], status: "running", tokens: 0, costUsd: 0, streaming }) as never
      const runTurn = (request: TurnRequest) => {
        if (request.runner === "claude") {
          return {
            result: Promise.resolve({
              status: "error",
              problem: limitNotice("Claude Code"),
              text: "",
              tokens: 0,
              costUsd: 0,
              talk: {} as never,
            } as TurnResult),
            stop: () => {},
          }
        }
        request.onUpdate?.(talk("Ci sono"))
        request.onUpdate?.(talk("Ci sono due sessioni."))
        return {
          result: Promise.resolve({
            status: "done",
            text: "Ci sono due sessioni.",
            tokens: 0,
            costUsd: 0,
            talk: {} as never,
          } as TurnResult),
          stop: () => {},
        }
      }
      const agent = createVoiceAgent({
        runTurn,
        statuses: () => [status("claude-code", "presente"), status("codex", "presente")],
        cwd: () => "C:/p",
        codexFallback: () => true,
      })

      const heard: string[] = []
      await agent.ask({ text: "quante sessioni?", engine: "auto", onText: (s) => heard.push(s) })
      expect(heard).toEqual([
        "Claude è al limite: rispondo con Codex. Ci sono",
        "Claude è al limite: rispondo con Codex. Ci sono due sessioni.",
      ])
    })

    test("in auto mode fallback uses English messages when locale is en", async () => {
      setLocalePreference("en")
      try {
        const runner = fakeRunner([
          { status: "error", problem: limitNotice("Claude Code"), text: "", tokens: 0, costUsd: 0, talk: {} as never },
          { status: "done", text: "Two active sessions.", tokens: 0, costUsd: 0, talk: {} as never },
        ])
        const agent = createVoiceAgent({
          runTurn: runner.runTurn,
          statuses: () => [status("claude-code", "presente"), status("codex", "presente")],
          cwd: () => "C:/p",
          codexFallback: () => true,
        })

        const answer = await agent.ask({ text: "how many sessions?", engine: "auto" })
        expect(answer.text).toBe("Claude is at its limit: answering with Codex. Two active sessions.")
      } finally {
        resetLocaleForTests()
      }
    })
  })

  test("the voice host's sentences run through the bots' runTurn, where the plan's cap is held", async () => {
    // S13: the cap on parallel turns is taken inside runTurn (bots/terms.ts
    // acquireTurn), shared by bots and the voice agent. Without the desktop
    // host runTurn stops at its own first check, and that answer can only
    // come from runTurn: so a sentence reaching it proves the path.
    const voice = createAdeVoiceHost({
      wb: () => createWorkbench(),
      setWb: () => {},
      project: () => undefined,
      runCommand: async () => {},
      isRunning: () => false,
      getRunningSession: () => undefined,
      openFile: async () => {},
      appendLine: () => {},
      tellPane: () => {},
      permissions: () => ({}),
      answerPermission: () => {},
    })
    expect(await voice.askAgent!({ text: "quante sessioni ci sono?", engine: "claude" })).toEqual({
      ok: false,
      text: "Nessun host: un turno si esegue solo nell'app desktop.",
      ran: true,
    })
  })
})

describe("who answers", () => {
  test("nik, on first-name terms, saying first what takes time", () => {
    expect(VOICE_AGENT_INSTRUCTIONS).toContain("Sei nik")
    expect(VOICE_AGENT_INSTRUCTIONS).toContain("dai del tu")
    expect(VOICE_AGENT_INSTRUCTIONS).toContain("prima una frase brevissima")
  })
})

describe("the warm process", () => {
  test("Claude turns go to it, with no session id; Codex turns do not; forgetting and releasing reach it", async () => {
    const cold: TurnRequest[] = []
    const warmRuns: TurnRequest[] = []
    const prepared: TurnRequest[] = []
    let forgotten = 0
    let closed = 0
    const done = (text: string) => ({
      result: Promise.resolve({
        status: "done",
        text,
        sessionId: "s1",
        tokens: 0,
        costUsd: 0,
        talk: {} as never,
      } as TurnResult),
      stop: () => {},
    })
    const agent = createVoiceAgent({
      runTurn: (request) => (cold.push(request), done("freddo")),
      warm: {
        prepare: (request) => void prepared.push(request),
        run: (request) => (warmRuns.push(request), done("caldo")),
        forget: () => void forgotten++,
        close: () => void closed++,
      },
      statuses: () => undefined,
      cwd: () => "C:/p",
    })
    agent.prepare({ engine: "auto", speed: "fast" })
    agent.prepare({ engine: "codex", speed: "fast" })
    expect(prepared).toHaveLength(1)
    expect(prepared[0]).toMatchObject({ runner: "claude", cwd: "C:/p", model: "claude-sonnet-5-5", partial: true })

    expect((await agent.ask({ text: "uno", engine: "claude", speed: "fast" })).text).toBe("caldo")
    expect((await agent.ask({ text: "due", engine: "claude", speed: "fast" })).text).toBe("caldo")
    expect(warmRuns.map((r) => r.sessionId)).toEqual([undefined, undefined])
    expect((await agent.ask({ text: "tre", engine: "codex" })).text).toBe("freddo")
    expect(cold).toHaveLength(1)
    agent.forget()
    expect(forgotten).toBe(1)
    agent.release()
    expect(closed).toBe(1)
  })

  test("a complete message is passed on with its end marked, so its last sentence is read at once", async () => {
    const heard: string[] = []
    const agent = createVoiceAgent({
      runTurn: (request) => {
        request.onUpdate?.({
          messages: [{ role: "user", text: "q", at: 0 }],
          status: "running",
          tokens: 0,
          costUsd: 0,
          streaming: "Fa",
        } as never)
        request.onUpdate?.({
          messages: [
            { role: "user", text: "q", at: 0 },
            { role: "bot", text: "Fa 4", at: 0 },
          ],
          status: "running",
          tokens: 0,
          costUsd: 0,
        } as never)
        return {
          result: Promise.resolve({
            status: "done",
            text: "Fa 4",
            tokens: 0,
            costUsd: 0,
            talk: {} as never,
          } as TurnResult),
          stop: () => {},
        }
      },
      statuses: () => undefined,
      cwd: () => "C:/p",
    })
    await agent.ask({ text: "q", engine: "claude", onText: (t) => heard.push(t) })
    expect(heard).toEqual(["Fa", "Fa 4\n\n"])
  })

  test("dopo B10 l'agente vocale gira in account-plan e perde ANTHROPIC_API_KEY e ANTHROPIC_BASE_URL ereditati", async () => {
    const runner = fakeRunner([{ text: "risposta vocale" }])
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => "C:/p" })
    await agent.ask({ text: "ciao", engine: "claude" })

    const req = runner.requests[0]!
    expect(req.account).toBeUndefined()

    // Con account non specificato (abbonamento), turnCommand produce flags con account-plan e nessun secret
    const cmd = turnCommand(runnerById("claude"), {
      bot: {
        identifier: "",
        path: "",
        scope: "global",
        description: "",
        mode: "primary",
        prompt: req.instructions ?? "",
        disabledTools: req.disabledTools ?? [],
        runner: "claude",
      },
      message: req.message,
      account: req.account,
    })
    expect(cmd.flags).toEqual(["account-plan"])
    expect(cmd.secrets).toBeUndefined()

    // Anche per il processo warm preparato per Claude:
    let preparedReq: TurnRequest | undefined
    const warmAgent = createVoiceAgent({
      runTurn: runner.runTurn,
      warm: {
        prepare: (r) => {
          preparedReq = r
        },
        run: () => ({
          result: Promise.resolve({ status: "done", text: "", tokens: 0, costUsd: 0, talk: {} as never }),
          stop: () => {},
        }),
        forget: () => {},
        close: () => {},
      },
      statuses: () => undefined,
      cwd: () => "C:/p",
    })
    warmAgent.prepare({ engine: "claude", speed: "fast" })
    expect(preparedReq).toBeDefined()
    expect(preparedReq!.account).toBeUndefined()
    const warmCmd = turnCommand(runnerById("claude"), {
      bot: {
        identifier: "",
        path: "",
        scope: "global",
        description: "",
        mode: "primary",
        prompt: preparedReq!.instructions ?? "",
        disabledTools: preparedReq!.disabledTools ?? [],
        runner: "claude",
      },
      message: preparedReq!.message,
      account: preparedReq!.account,
    })
    expect(warmCmd.flags).toEqual(["account-plan"])
    expect(warmCmd.secrets).toBeUndefined()
  })
})

describe("the planner runs on the agent's own runner", () => {
  const done = (text: string, extra: Partial<TurnResult> = {}) => ({
    result: Promise.resolve({ status: "done", text, tokens: 0, costUsd: 0, talk: {} as never, ...extra } as TurnResult),
    stop: () => {},
  })

  function setup(engineStatuses?: AgentStatus[]) {
    const cold: TurnRequest[] = []
    const planRuns: TurnRequest[] = []
    const planPrepared: TurnRequest[] = []
    const agentRuns: TurnRequest[] = []
    let planForgotten = 0
    let planClosed = 0
    const agent = createVoiceAgent({
      runTurn: (request) => (cold.push(request), done("freddo")),
      warm: {
        prepare: () => {},
        run: (request) => (agentRuns.push(request), done("agente")),
        forget: () => {},
        close: () => {},
      },
      planWarm: {
        prepare: (request) => void planPrepared.push(request),
        run: (request) => (planRuns.push(request), done('{"speech":"ok","steps":[]}')),
        forget: () => void planForgotten++,
        close: () => void planClosed++,
      },
      statuses: () => engineStatuses,
      cwd: () => "C:/p",
    })
    return { agent, cold, planRuns, planPrepared, agentRuns, forgotten: () => planForgotten, closed: () => planClosed }
  }

  test("Claude plans in a process of its own, not the agent's: Sonnet 5.5 low, the rules as instructions, the rest as the message", async () => {
    const { agent, planRuns, agentRuns, cold } = setup()
    const text = await agent.plan({ system: "REGOLE", user: "DATI e frase", engine: "claude", speed: "fast" })
    expect(text).toBe('{"speech":"ok","steps":[]}')
    expect(planRuns).toHaveLength(1)
    expect(planRuns[0]).toMatchObject({
      runner: "claude",
      instructions: "REGOLE",
      message: "DATI e frase",
      model: "claude-sonnet-5-5",
      effort: "low",
      cwd: "C:/p",
      partial: true,
      lean: true,
      timeoutMs: VOICE_PLAN_TIMEOUT_MS,
    })
    // Nothing of the agent's: no identity on ade-msg, so nothing to list, send or close.
    expect(planRuns[0].mailbox).toBeUndefined()
    expect(planRuns[0].disabledTools).toBe(VOICE_AGENT_DISABLED_TOOLS)
    expect(agentRuns).toHaveLength(0)
    expect(cold).toHaveLength(0)
  })

  test("cli speed leaves the model to the CLI", async () => {
    const { agent, planRuns } = setup()
    await agent.plan({ system: "R", user: "U", engine: "claude", speed: "cli" })
    expect(planRuns[0].model).toBeUndefined()
    expect(planRuns[0].effort).toBeUndefined()
  })

  test("Codex plans with a turn of its own, on its own subscription", async () => {
    const { agent, cold, planRuns } = setup()
    await agent.plan({ system: "R", user: "U", engine: "codex", speed: "fast" })
    expect(planRuns).toHaveLength(0)
    expect(cold).toHaveLength(1)
    expect(cold[0]).toMatchObject({ runner: "codex", instructions: "R", message: "U", effort: "low" })
    expect(cold[0].model).toBeUndefined()
  })

  test("Claude's planner has no tools at all, not even ade-msg: the sentence and the pane titles are not to be obeyed", async () => {
    const { agent, planRuns } = setup()
    await agent.plan({ system: "R", user: "U", engine: "claude", speed: "fast" })
    expect(planRuns[0].noTools).toBe(true)
    expect(planRuns[0].mailbox).toBeUndefined()
  })

  test("nikcli's planner has no tools either, and no model of its own choosing: the turn picks a free one at run time", async () => {
    const { agent, cold } = setup()
    await agent.plan({ system: "R", user: "U", engine: "nikcli", speed: "fast" })
    expect(cold[0].noTools).toBe(true)
    expect(cold[0].model).toBeUndefined()
    expect(cold[0].freeModels?.length).toBeGreaterThan(0)
    for (const model of cold[0].freeModels ?? []) expect(isFreeModel(model)).toBe(true)
  })

  test("the planner gives up after eight seconds: the coldest answer measured was five", async () => {
    const { agent, planRuns } = setup()
    await agent.plan({ system: "R", user: "U", engine: "claude" })
    expect(planRuns[0].timeoutMs).toBe(8_000)
  })

  test("the sentence already said is told to the agent, which is not to say it again", async () => {
    const { agent, agentRuns } = setup()
    await agent.ask({ text: "chi ha scritto l'ultimo commit?", engine: "claude", alreadySaid: "Controllo il log git." })
    expect(agentRuns[0].message).toContain("chi ha scritto l'ultimo commit?")
    expect(agentRuns[0].message).toContain("Controllo il log git.")
    expect(agentRuns[0].message).toMatch(/già sentito/i)
    await agent.ask({ text: "un'altra frase", engine: "claude" })
    expect(agentRuns[1].message).toBe("un'altra frase")
  })

  test("with no CLI installed it says so, in the words the agent would use", async () => {
    const { agent } = setup(["claude-code", "codex", "nikcli"].map((id) => status(id, "assente")))
    await expect(agent.plan({ system: "R", user: "U", engine: "auto" })).rejects.toThrow(
      /Non riesco a pianificare: .*Claude Code/,
    )
  })

  test("a turn that failed rejects with what the CLI said", async () => {
    const agent = createVoiceAgent({
      runTurn: () => done("", { status: "error", problem: "Claude Code non si avvia." }),
      statuses: () => undefined,
      cwd: () => "C:/p",
    })
    await expect(agent.plan({ system: "R", user: "U", engine: "codex" })).rejects.toThrow(
      "Non riesco a pianificare: Claude Code non si avvia.",
    )
  })

  test("stopped by the signal it rejects as an abort, which is not a failure to report", async () => {
    const controller = new AbortController()
    const agent = createVoiceAgent({
      runTurn: () => ({
        result: new Promise<TurnResult>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve({ status: "stopped", text: "" } as TurnResult)),
        ),
        stop: () => {},
      }),
      statuses: () => undefined,
      cwd: () => "C:/p",
    })
    const pending = agent.plan({ system: "R", user: "U", engine: "codex", signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  test("the answer is handed on as it grows, once for each change", async () => {
    const heard: string[] = []
    const agent = createVoiceAgent({
      runTurn: (request) => {
        const streaming = (text: string) => ({ messages: [], streaming: text }) as never
        request.onUpdate?.(streaming('{"speech":"Ap'))
        request.onUpdate?.(streaming('{"speech":"Ap'))
        request.onUpdate?.(streaming('{"speech":"Apro."'))
        return done('{"speech":"Apro.","steps":[]}')
      },
      statuses: () => undefined,
      cwd: () => "C:/p",
    })
    await agent.plan({ system: "R", user: "U", engine: "codex", onText: (soFar) => void heard.push(soFar) })
    expect(heard).toEqual(['{"speech":"Ap', '{"speech":"Apro."'])
  })

  test(`after ${VOICE_PLAN_SESSION_PHRASES} sentences the conversation starts again, so the cache stays small`, async () => {
    const { agent, planRuns, forgotten } = setup()
    for (let i = 0; i < VOICE_PLAN_SESSION_PHRASES; i++)
      await agent.plan({ system: "R", user: `frase ${i}`, engine: "claude" })
    expect(forgotten()).toBe(0)
    await agent.plan({ system: "R", user: "una in più", engine: "claude" })
    expect(forgotten()).toBe(1)
    expect(planRuns).toHaveLength(VOICE_PLAN_SESSION_PHRASES + 1)
    // And the count starts over.
    for (let i = 0; i < VOICE_PLAN_SESSION_PHRASES - 1; i++)
      await agent.plan({ system: "R", user: `frase ${i}`, engine: "claude" })
    expect(forgotten()).toBe(1)
  })

  test("preparing the voice starts the planner's process with the real rules, and forgetting or releasing reach it", () => {
    const { agent, planPrepared, forgotten, closed } = setup()
    agent.prepare({ engine: "claude", speed: "fast" })
    expect(planPrepared).toHaveLength(1)
    expect(planPrepared[0]).toMatchObject({
      runner: "claude",
      instructions: PLANNER_SYSTEM,
      message: "",
      model: "claude-sonnet-5-5",
      partial: true,
    })
    // The same configuration as the sentence's own request: the process waiting is the one that answers.
    agent.forget()
    expect(forgotten()).toBe(1)
    agent.release()
    expect(closed()).toBe(1)
  })
})
