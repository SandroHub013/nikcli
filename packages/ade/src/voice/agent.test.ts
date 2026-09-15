import { describe, expect, test } from "bun:test"
import type { AgentStatus } from "../session-new/availability"
import type { TurnRequest, TurnResult } from "../bots/turn"
import { createVoiceAgent, resolveVoiceAgentRunner, VOICE_AGENT_INSTRUCTIONS } from "./agent"

const status = (id: string, availability: AgentStatus["availability"]): AgentStatus =>
  ({ agent: { id, label: id, command: id }, availability }) as AgentStatus

describe("voice/agent", () => {
  test("auto takes the first installed CLI, in subscription order", () => {
    expect(resolveVoiceAgentRunner("auto", [status("claude-code", "assente"), status("codex", "presente")])).toEqual({
      runner: "codex",
    })
    expect(resolveVoiceAgentRunner("auto", undefined)).toEqual({ runner: "claude" })
    expect(resolveVoiceAgentRunner("codex", [status("codex", "assente")])).toEqual({ runner: "codex" })
    const none = resolveVoiceAgentRunner("auto", ["claude-code", "codex", "nikcli"].map((id) => status(id, "assente")))
    expect("problem" in none && none.problem).toContain("Claude Code")
  })

  function fakeRunner(results: Partial<TurnResult>[]) {
    const requests: TurnRequest[] = []
    let stops = 0
    const runTurn = (request: TurnRequest) => {
      requests.push(request)
      const next = results.shift() ?? {}
      return {
        result: Promise.resolve({ status: "done", text: "", tokens: 0, costUsd: 0, talk: {} as never, ...next } as TurnResult),
        stop: () => stops++,
      }
    }
    return { runTurn, requests, stops: () => stops }
  }

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
    })
    await agent.ask({ text: "e la seconda?", engine: "claude" })

    expect(runner.requests[0]).toMatchObject({ runner: "claude", cwd: "C:/p", mailbox: { id: "voce" } })
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

    expect(await agent.ask({ text: "x", engine: "claude" })).toEqual({ ok: false, text: "claude non si avvia: ENOENT" })

    const abort = new AbortController()
    const pending = agent.ask({ text: "y", engine: "claude", signal: abort.signal })
    abort.abort()
    expect((await pending).ok).toBe(false)
    expect(runner.stops()).toBe(1)
  })
})
