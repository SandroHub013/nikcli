import { describe, expect, test } from "bun:test"
import type { AgentFile } from "./nikcli"
import { applyRunnerLine, readLoginStatus, runnerById, turnCommand } from "./runners"
import { emptyTalk, sendMessage, type Talk } from "./talk"

const bot: AgentFile = {
  identifier: "tester",
  path: "C:/p/.nikcli/agent/tester.md",
  scope: "project",
  description: "Scrive i test.",
  mode: "primary",
  prompt: "Sei un tester.",
  disabledTools: [],
}

function fold(runnerId: string, lines: readonly string[]): Talk {
  const runner = runnerById(runnerId)
  return lines.reduce((talk, line) => applyRunnerLine(runner, talk, line, 1000), sendMessage(emptyTalk(), "ciao", 1))
}

describe("il motore di un bot", () => {
  test("senza chiave è nikcli, e una chiave sconosciuta pure", () => {
    expect(runnerById(undefined).id).toBe("nikcli")
    expect(runnerById("boh").id).toBe("nikcli")
    expect(runnerById("claude").label).toBe("Claude Code")
  })
})

describe("gli argomenti di un turno", () => {
  test("nikcli resta `run --agent`", () => {
    const { command, args } = turnCommand(runnerById("nikcli"), { bot: { ...bot, model: "openai/gpt-5.5" }, message: "ciao" })
    expect(command).toBe("nikcli")
    expect(args.slice(0, 3)).toEqual(["run", "--agent", "tester"])
    expect(args).toContain("openai/gpt-5.5")
  })

  test("Claude Code: stream-json, persona come system prompt, sessione ripresa, messaggio dopo --", () => {
    const { command, args } = turnCommand(runnerById("claude"), {
      bot: { ...bot, model: "sonnet", effort: "high", disabledTools: ["bash"] },
      message: "-x ciao",
      sessionId: "abc",
    })
    expect(command).toBe("claude")
    expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"])
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet")
    expect(args[args.indexOf("--effort") + 1]).toBe("high")
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("Sei un tester.")
    expect(args[args.indexOf("--resume") + 1]).toBe("abc")
    expect(args[args.indexOf("--allowedTools") + 1]).not.toContain("Bash")
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Bash")
    expect(args.slice(-2)).toEqual(["--", "-x ciao"])
  })

  test("Codex: il primo turno porta la persona, il seguito riprende il thread", () => {
    const first = turnCommand(runnerById("codex"), { bot: { ...bot, effort: "low" }, message: "ciao" })
    expect(first.args.slice(0, 2)).toEqual(["exec", "--json"])
    expect(first.args).toContain('model_reasoning_effort="low"')
    expect(first.args.at(-1)).toContain("Sei un tester.")
    expect(first.args.at(-1)?.endsWith("ciao")).toBe(true)

    const next = turnCommand(runnerById("codex"), { bot, message: "e poi?", sessionId: "t-1" })
    expect(next.args.slice(0, 3)).toEqual(["exec", "resume", "--json"])
    expect(next.args.slice(-2)).toEqual(["t-1", "e poi?"])
  })

  test("un bot che non può scrivere gira in sola lettura", () => {
    const { args } = turnCommand(runnerById("codex"), { bot: { ...bot, disabledTools: ["edit"] }, message: "x" })
    expect(args).toContain('sandbox_mode="read-only"')
  })
})

describe("gli eventi di Claude Code", () => {
  const lines = [
    '{"type":"system","subtype":"init","cwd":"C:\\\\p","session_id":"25013bee","tools":["Read"]}',
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""}]},"session_id":"25013bee"}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"C:\\\\p\\\\package.json"}}]},"session_id":"25013bee"}',
    '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1\\t{\\n2\\t  \\"name\\": \\"@nikcli-ai/ade\\""}]},"session_id":"25013bee"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"`@nikcli-ai/ade`"}]},"session_id":"25013bee"}',
    '{"type":"result","subtype":"success","is_error":false,"session_id":"25013bee","total_cost_usd":0.04,"usage":{"input_tokens":18,"cache_creation_input_tokens":100,"cache_read_input_tokens":200,"output_tokens":6,"server_tool_use":{"web_search_requests":0}},"permission_denials":[]}',
  ]

  test("sessione, strumento con il suo output, risposta, costo", () => {
    const talk = fold("claude", lines)
    expect(talk.sessionId).toBe("25013bee")
    const [, tool, reply] = talk.messages
    expect(tool).toMatchObject({ role: "tool", tool: "Read", text: "C:\\p\\package.json" })
    expect(tool?.output).toContain("@nikcli-ai/ade")
    expect(reply).toMatchObject({ role: "bot", text: "`@nikcli-ai/ade`" })
    expect(talk.tokens).toBe(324)
    expect(talk.costUsd).toBeCloseTo(0.04)
  })

  test("un permesso negato si dice sul thread", () => {
    const talk = fold("claude", [
      '{"type":"result","is_error":false,"session_id":"s","permission_denials":[{"tool_name":"Bash","tool_input":{}}]}',
    ])
    expect(talk.messages.at(-1)).toMatchObject({ role: "error" })
    expect(talk.messages.at(-1)?.text).toContain("Bash")
  })

  test("una conversazione che Claude Code non ha più si dimentica", () => {
    const talk = fold("claude", [
      '{"type":"system","subtype":"init","session_id":"vecchia"}',
      '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"vecchia","errors":["No conversation found with session ID: vecchia"]}',
    ])
    expect(talk.sessionId).toBeUndefined()
    expect(talk.messages.at(-1)?.text).toContain("nuova")
  })

  test("un risultato in errore mette il thread in errore", () => {
    const talk = fold("claude", ['{"type":"result","is_error":true,"result":"Credit balance is too low"}'])
    expect(talk.status).toBe("error")
    expect(talk.messages.at(-1)?.text).toBe("Credit balance is too low")
  })
})

describe("gli eventi di Codex", () => {
  test("thread, comando con output, risposta, token senza contare due volte la cache", () => {
    const talk = fold("codex", [
      '{"type":"thread.started","thread_id":"01a0a471"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"git branch --show-current","aggregated_output":"","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"git branch --show-current","aggregated_output":"feat/ade\\n","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Il branch corrente è `feat/ade`."}}',
      '{"type":"turn.completed","usage":{"input_tokens":32962,"cached_input_tokens":20224,"output_tokens":65,"reasoning_output_tokens":0}}',
    ])
    expect(talk.sessionId).toBe("01a0a471")
    expect(talk.messages).toHaveLength(3)
    expect(talk.messages[1]).toMatchObject({ role: "tool", tool: "shell", output: "feat/ade\n" })
    expect(talk.messages[2]).toMatchObject({ role: "bot", text: "Il branch corrente è `feat/ade`." })
    expect(talk.tokens).toBe(33027)
  })

  test("un turno fallito è un errore", () => {
    const talk = fold("codex", ['{"type":"turn.failed","error":{"message":"usage limit reached"}}'])
    expect(talk.status).toBe("error")
    expect(talk.messages.at(-1)?.text).toBe("usage limit reached")
  })
})

describe("lo stato di accesso", () => {
  test("Claude Code con l'abbonamento", () => {
    const state = readLoginStatus(runnerById("claude"), '{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}', 0)
    expect(state).toEqual({ state: "in", detail: "Abbonamento Claude" })
  })

  test("Claude Code senza accesso", () => {
    expect(readLoginStatus(runnerById("claude"), '{"loggedIn": false}', 1).state).toBe("out")
  })

  test("Codex con ChatGPT, e senza", () => {
    expect(readLoginStatus(runnerById("codex"), "Logged in using ChatGPT\r\n", 0)).toEqual({
      state: "in",
      detail: "Accesso con ChatGPT",
    })
    expect(readLoginStatus(runnerById("codex"), "Not logged in", 1).state).toBe("out")
  })

  test("nikcli che si ferma prima dell'elenco non dice «non collegato»", () => {
    expect(readLoginStatus(runnerById("nikcli"), "ERROR EPERM: operation not permitted fatal", 1).state).toBe("unknown")
    expect(readLoginStatus(runnerById("nikcli"), "└  0 credentials", 0).state).toBe("out")
  })

  test("nikcli elenca i provider, colori e cornici tolti", () => {
    const output = [
      "\u001b[90m┌\u001b[39m  Credentials \u001b[90m~\\AppData\\Local\\nikcli\\auth.json",
      "\u001b[90m│\u001b[39m",
      "\u001b[34m●\u001b[39m  OpenAI \u001b[90moauth",
      "\u001b[34m●\u001b[39m  Z.AI Coding Plan \u001b[90mapi",
      "\u001b[90m└\u001b[39m  2 credentials",
    ].join("\r\n")
    expect(readLoginStatus(runnerById("nikcli"), output, 0)).toEqual({ state: "in", detail: "OpenAI, Z.AI Coding Plan" })
  })
})
