import { describe, expect, test } from "bun:test"
import type { AgentFile } from "./nikcli"
import { answerSoFar, applyRunnerLine, enforcesDisabledTools, finalText, formatUsd, generationSpend, readLoginStatus, runnerById, spendLine, turnCommand } from "./runners"
import { emptyTalk, parseTalk, sendMessage, serializeTalk, type Talk } from "./talk"

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

  test("un turno leggero di Claude Code salta MCP e impostazioni utente, ma può usare ade-msg", () => {
    // The user's own bot: a project's gets none of this (B3, below).
    const mine: AgentFile = { ...bot, scope: "global" }
    const { args } = turnCommand(runnerById("claude"), { bot: mine, message: "x", lean: true })
    expect(args).toContain("--strict-mcp-config")
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}')
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("")
    expect(args[args.indexOf("--settings") + 1]).toBe('{"autoMemoryEnabled":false}')
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("PowerShell(ade-msg *)")
    expect(turnCommand(runnerById("claude"), { bot, message: "x" }).args).not.toContain("--strict-mcp-config")
  })

  test("un bot che non può scrivere gira in sola lettura", () => {
    const { args } = turnCommand(runnerById("codex"), { bot: { ...bot, disabledTools: ["edit"] }, message: "x" })
    expect(args).toContain('sandbox_mode="read-only"')
  })

  test("un turno vocale non scrive e non esegue altro che ade-msg, su ogni motore che lo sa rifiutare", () => {
    // As `turn.ts` builds it: the voice's bot is ADE's, not a project's.
    const voice: AgentFile = { ...bot, scope: "global", disabledTools: ["edit", "write", "bash", "webfetch", "websearch"] }

    const claude = turnCommand(runnerById("claude"), { bot: voice, message: "x", lean: true }).args
    const allowed = claude[claude.indexOf("--allowedTools") + 1]!.split(",")
    const disallowed = claude[claude.indexOf("--disallowedTools") + 1]!.split(",")
    expect(claude[claude.indexOf("--permission-mode") + 1]).toBe("default")
    // No settings file, the project's local one included, can pre-approve a command.
    expect(claude[claude.indexOf("--setting-sources") + 1]).toBe("")
    expect(allowed).toContain("Bash(ade-msg *)")
    expect(allowed).toContain("PowerShell(ade-msg *)")
    for (const tool of ["Bash", "PowerShell", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"]) expect(allowed).not.toContain(tool)
    expect(disallowed).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"]))
    // A refusal beats an allow: refusing Bash would refuse ade-msg too.
    expect(disallowed).not.toContain("Bash")

    const outbox = "C:/Users/x/AppData/Local/ai.nikcli.ade/mailbox/outbox"
    const codex = turnCommand(runnerById("codex"), { bot: voice, message: "x", outbox })
    expect(codex.args).toContain('sandbox_mode="workspace-write"')
    expect(codex.cwd).toBe(outbox)
    const resumed = turnCommand(runnerById("codex"), { bot: voice, message: "x", sessionId: "t-1", outbox })
    expect(resumed.cwd).toBe(outbox)
    expect(resumed.args).toContain('sandbox_mode="workspace-write"')
    // Without an outbox there is nothing to make writable: fully read-only, and the project's cwd.
    const plain = turnCommand(runnerById("codex"), { bot: voice, message: "x" })
    expect(plain.args).toContain('sandbox_mode="read-only"')
    expect(plain.cwd).toBeUndefined()
    // A bot that may write keeps its project as the workspace.
    expect(turnCommand(runnerById("codex"), { bot, message: "x", outbox }).cwd).toBeUndefined()

    expect(enforcesDisabledTools("claude")).toBe(true)
    expect(enforcesDisabledTools("codex")).toBe(true)
    expect(enforcesDisabledTools("nikcli")).toBe(false)
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

  test("una scrittura negata su un percorso protetto non dice di abilitare lo strumento (review B7, BASSO 2)", () => {
    const talk = fold("claude", [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_9","name":"Write","input":{"file_path":"C:\\\\p\\\\.Git\\\\hooks\\\\x"}}]},"session_id":"s"}',
      '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_9","type":"tool_result","is_error":true,"content":"<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>"}]},"session_id":"s"}',
      '{"type":"result","is_error":false,"session_id":"s","permission_denials":[{"tool_name":"Write","tool_use_id":"toolu_9","tool_input":{}}]}',
    ])
    const said = talk.messages.filter((message) => message.role === "error").map((message) => message.text)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain("percorso protetto")
    expect(said[0]).not.toContain("Abilita")
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

describe("un errore di Codex detto due volte", () => {
  test("error e poi turn.failed con lo stesso testo: sul thread una volta sola (review B7, BASSO 1)", () => {
    const limit = "You've hit your usage limit."
    const talk = fold("codex", [
      `{"type":"error","message":${JSON.stringify(limit)}}`,
      `{"type":"turn.failed","error":{"message":${JSON.stringify(limit)}}}`,
    ])
    expect(talk.messages.filter((message) => message.role === "error" && message.text === limit)).toHaveLength(1)
    expect(talk.status).toBe("error")
    expect(talk.ended).toBe(true)
  })
})

describe("la risposta finale di un turno", () => {
  test("sono i messaggi del bot dopo l'ultima domanda, senza strumenti né errori", () => {
    const talk = fold("claude", [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Controllo."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Ci sono 3 file."}]}}',
    ])
    expect(finalText(talk)).toBe("Controllo.\n\nCi sono 3 file.")
    expect(finalText(sendMessage(talk, "e poi?", 2))).toBe("")
  })

  test("nikcli senza agente usa quello predefinito", () => {
    const { args } = turnCommand(runnerById("nikcli"), { bot: { ...bot, identifier: "" }, message: "ciao" })
    expect(args).not.toContain("--agent")
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

describe("la risposta mentre Claude Code la scrive", () => {
  const ev = (event: object, parent: string | null = null) =>
    JSON.stringify({ type: "stream_event", event, session_id: "s", parent_tool_use_id: parent })
  const delta = (text: string, parent: string | null = null) =>
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, parent)

  test("chiesta con --include-partial-messages", () => {
    const { args } = turnCommand(runnerById("claude"), { bot, message: "ciao", partial: true })
    expect(args).toContain("--include-partial-messages")
    expect(turnCommand(runnerById("claude"), { bot, message: "ciao" }).args).not.toContain("--include-partial-messages")
  })

  test("cresce a ogni pezzo, e il messaggio completo la sostituisce senza ripeterla", () => {
    const seen: string[] = []
    let talk = fold("claude", ['{"type":"system","subtype":"init","session_id":"s"}'])
    const lines = [
      ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      delta("Roma è la capitale d"),
      delta("'Italia. È antica"),
      delta("x", "toolu_sub"),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Roma è la capitale d\u0027Italia. È antica."}]},"session_id":"s","parent_tool_use_id":null}',
    ]
    for (const line of lines) {
      talk = applyRunnerLine(runnerById("claude"), talk, line, 0)
      seen.push(answerSoFar(talk))
    }
    expect(seen).toEqual([
      "",
      "Roma è la capitale d",
      "Roma è la capitale d'Italia. È antica",
      "Roma è la capitale d'Italia. È antica",
      "Roma è la capitale d'Italia. È antica.",
    ])
    expect(talk.streaming).toBeUndefined()
    expect(talk.messages.filter((m) => m.role === "bot")).toHaveLength(1)
  })

  test("un secondo messaggio si aggiunge al primo", () => {
    let talk = fold("claude", ['{"type":"assistant","message":{"content":[{"type":"text","text":"Controllo."}]},"session_id":"s"}'])
    talk = applyRunnerLine(runnerById("claude"), talk, ev({ type: "content_block_start", index: 0 }), 0)
    talk = applyRunnerLine(runnerById("claude"), talk, delta("Ci sono due"), 0)
    expect(answerSoFar(talk)).toBe("Controllo.\n\nCi sono due")
  })
})

describe("Claude Code reading its messages from stdin", () => {
  test("asks for stream-json input and passes no message", () => {
    const { args } = turnCommand(runnerById("claude"), { bot, message: "ignorato", stdin: true })
    expect(args.slice(0, 6)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json"])
    expect(args).not.toContain("--")
    expect(args).not.toContain("ignorato")
  })
})

/*
 * B1 (audit A1): what a bot file or a message puts on Codex's command line.
 * The shim problem itself is closed in `pty.rs` (`launch_plan`); these are
 * the arguments ADE builds, which must not carry a second option or config.
 */
describe("gli argomenti di Codex non portano altro", () => {
  test("il primo turno contiene la domanda, dopo la persona su più righe, intera", () => {
    const persona = { ...bot, prompt: "Sei un tester.\nRispondi in breve." }
    const { args } = turnCommand(runnerById("codex"), { bot: persona, message: "quanto fa 2+2?\nE 3+3?" })
    expect(args.at(-2)).toBe("--")
    const last = args.at(-1)!
    expect(last).toContain("Rispondi in breve.")
    expect(last.endsWith("quanto fa 2+2?\nE 3+3?")).toBe(true)
  })

  test("un variant o un modello con virgolette, a capo o & dal file del bot non arrivano a -c e -m", () => {
    const hostile = {
      ...bot,
      effort: 'high" & echo INIETTATO & rem "',
      model: "gpt-5 & echo INIETTATO",
    }
    const { args } = turnCommand(runnerById("codex"), { bot: hostile, message: "ciao" })
    expect(args.join(" ")).not.toContain("INIETTATO")
    expect(args).not.toContain("-m")
    expect(args.some((arg) => arg.startsWith("model_reasoning_effort"))).toBe(false)
    const newline = turnCommand(runnerById("codex"), { bot: { ...bot, effort: 'low"\nsandbox_mode="danger-full-access' }, message: "x" })
    expect(newline.args.join(" ")).not.toContain("danger-full-access")
  })

  test("valori normali passano come prima", () => {
    const { args } = turnCommand(runnerById("codex"), { bot: { ...bot, effort: "xhigh", model: "gpt-5.1-codex" }, message: "x" })
    expect(args).toContain('model_reasoning_effort="xhigh"')
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.1-codex")
  })

  test("nel seguito, un messaggio che comincia con - resta un messaggio", () => {
    const { args } = turnCommand(runnerById("codex"), { bot, message: "--dangerously-bypass-approvals-and-sandbox", sessionId: "t-1" })
    expect(args.slice(-3)).toEqual(["--", "t-1", "--dangerously-bypass-approvals-and-sandbox"])
  })
})

/*
 * B1 review, BASSO 1: for `codex exec` and `exec resume`, a PROMPT of `-`
 * means «read it from stdin», and the turn hung until stopped. A message
 * that is only a dash is sent so that it is not that argument.
 */
describe("un messaggio fatto solo di un trattino", () => {
  test("non diventa il «leggi da stdin» di Codex, né al primo turno né nel seguito", () => {
    const plain = { ...bot, prompt: "" }
    for (const message of ["-", "  -  "]) {
      const first = turnCommand(runnerById("codex"), { bot: plain, message })
      expect(first.args.at(-1)).not.toBe("-")
      expect(first.args.at(-1)?.trim()).toBe("-")
      const next = turnCommand(runnerById("codex"), { bot, message, sessionId: "t-1" })
      expect(next.args.at(-1)).not.toBe("-")
      expect(next.args.at(-2)).toBe("t-1")
    }
  })

  test("un messaggio che contiene un trattino resta com'è", () => {
    const { args } = turnCommand(runnerById("codex"), { bot, message: "a - b", sessionId: "t-1" })
    expect(args.at(-1)).toBe("a - b")
  })
})

/*
 * B3 (audit A4): a bot from the project's `.nikcli/agent/` was run with the
 * shell pre-approved, the project's local Claude settings (hooks included)
 * loaded, and Codex never asking. A bot the user wrote keeps what it had.
 */
describe("un bot di progetto non ha pre-approvazioni", () => {
  const fromRepo: AgentFile = { ...bot, scope: "project" }
  const mine: AgentFile = { ...bot, scope: "global" }

  test("Claude: niente shell pre-approvata, niente ade-msg, niente impostazioni locali", () => {
    const { args } = turnCommand(runnerById("claude"), { bot: fromRepo, message: "x", lean: true })
    const allowed = args[args.indexOf("--allowedTools") + 1] ?? ""
    expect(allowed).not.toMatch(/Bash|PowerShell/)
    expect(args.join(" ")).not.toContain("ade-msg")
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("")
  })

  test("Codex: nessun approval_policy per un bot di progetto (codex-cli 0.154 esce con 1 su \"untrusted\", B7)", () => {
    for (const spec of [
      { bot: fromRepo, message: "x" },
      { bot: fromRepo, message: "x", sessionId: "t-1" },
    ]) {
      const { args } = turnCommand(runnerById("codex"), spec)
      expect(args.some((arg) => arg.startsWith("approval_policy="))).toBe(false)
      expect(args).toContain('sandbox_mode="read-only"')
    }
  })

  test("Codex: sempre in sola lettura, perché codex exec ignora approval_policy (review B3, A1)", () => {
    for (const spec of [
      { bot: fromRepo, message: "x" },
      { bot: fromRepo, message: "x", sessionId: "t-1" },
      { bot: fromRepo, message: "x", outbox: "C:/mailbox/outbox" },
    ]) {
      const { args, cwd } = turnCommand(runnerById("codex"), spec)
      expect(args).toContain('sandbox_mode="read-only"')
      expect(args.join(" ")).not.toContain("workspace-write")
      expect(cwd).toBeUndefined()
    }
  })

  test("Claude: niente scritture nei percorsi che poi eseguono codice (review B3, M1)", () => {
    const { args } = turnCommand(runnerById("claude"), { bot: fromRepo, message: "x", lean: true })
    const disallowed = (args[args.indexOf("--disallowedTools") + 1] ?? "").split(",")
    for (const path of [".git", ".claude", ".nikcli", ".codex", ".husky", ".vscode", ".github/workflows"]) {
      for (const tool of ["Edit", "Write", "NotebookEdit"]) expect(disallowed).toContain(`${tool}(./${path}/**)`)
    }
    // Writing elsewhere is still what the user accepted.
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits")
  })

  test("un bot dell'utente resta com'era", () => {
    const claude = turnCommand(runnerById("claude"), { bot: mine, message: "x", lean: true }).args
    expect(claude[claude.indexOf("--allowedTools") + 1]).toContain("Bash")
    expect(claude[claude.indexOf("--setting-sources") + 1]).toBe("")
    expect(claude.join(" ")).not.toContain("(./.git/**)")
    const codex = turnCommand(runnerById("codex"), { bot: mine, message: "x" }).args
    expect(codex).toContain('approval_policy="never"')
    expect(codex).toContain('sandbox_mode="workspace-write"')
  })
})

/*
 * B3b review, M1: nikcli merges the project's `.nikcli/` over the user's own
 * configuration, so a project agent of the same name took the place of the
 * user's bot, and the project's plugins ran, with no question asked. A bot of
 * the user's runs without the project's configuration; a project's bot needs
 * it, and `project-trust.ts` asks about it.
 */
describe("un bot dell'utente su nikcli non carica la configurazione del progetto", () => {
  test("B8c: nikcli chiede di ogni comando solo a chi risponde (il pannello), mai alla voce", () => {
    const global = { ...bot, scope: "global" as const }
    expect(turnCommand(runnerById("nikcli"), { bot: global, message: "x", approvals: true }).flags).toEqual([
      "no-project-config",
      "bot-ask-shell",
    ])
    const noShell = { ...global, disabledTools: ["bash"] }
    expect(turnCommand(runnerById("nikcli"), { bot: noShell, message: "x", approvals: true }).flags).toEqual([
      "no-project-config",
      "bot-ask-outside",
    ])
    // Without someone to answer, nothing is asked: the shell is denied (second check, ALTO).
    expect(turnCommand(runnerById("nikcli"), { bot: global, message: "x" }).flags).toEqual(["no-project-config", "bot-no-shell"])
    // A chat's turn keeps its own rules.
    expect(
      turnCommand(runnerById("nikcli"), { bot: global, message: "x", approvals: true, remote: { commands: false } }).flags,
    ).toEqual(["no-project-config", "remote-no-shell"])
  })

  test("il bot globale gira con no-project-config, quello di progetto no", () => {
    const mine = turnCommand(runnerById("nikcli"), { bot: { ...bot, scope: "global" }, message: "x" })
    expect(mine.flags).toEqual(["no-project-config", "bot-no-shell"])
    const fromRepo = turnCommand(runnerById("nikcli"), { bot: { ...bot, scope: "project" }, message: "x" })
    expect(fromRepo.flags).toEqual(["bot-no-shell"])
  })

  test("Claude Code e Codex non ricevono l'opzione di nikcli", () => {
    for (const runner of ["claude", "codex"]) {
      const flags = turnCommand(runnerById(runner), { bot: { ...bot, scope: "global" }, message: "x", lean: true }).flags
      expect(flags).toEqual(["account-plan"])
      expect(flags).not.toContain("no-project-config")
    }
  })

  test("un bot Claude del pannello non legge nessun file di impostazioni, nemmeno quello locale del progetto", () => {
    for (const scope of ["global", "project"] as const) {
      const { args } = turnCommand(runnerById("claude"), { bot: { ...bot, scope }, message: "x", lean: true })
      expect(args[args.indexOf("--setting-sources") + 1]).toBe("")
    }
  })
})

/*
 * G5, D93: a turn from a chat, through a bot's gateway. Nobody is at the
 * computer, so no shell unless the owner turned on the bot's remote commands;
 * with them on, nikcli asks on the phone, Claude Code runs only a list, and
 * Codex stays read-only.
 */
describe("un turno da chat non ha la shell", () => {
  const mine: AgentFile = { ...bot, scope: "global" }
  const off = { commands: false }
  const on = { commands: true }
  const allowedOf = (args: readonly string[]) => (args[args.indexOf("--allowedTools") + 1] ?? "").split(",")
  const disallowedOf = (args: readonly string[]) => (args[args.indexOf("--disallowedTools") + 1] ?? "").split(",")

  test("Claude: niente Bash né PowerShell, né consentiti né lasciati al caso, e niente ade-msg", () => {
    const { args } = turnCommand(runnerById("claude"), { bot: mine, message: "x", remote: off })
    expect(allowedOf(args).filter((tool) => /Bash|PowerShell/.test(tool))).toEqual([])
    expect(disallowedOf(args)).toContain("Bash")
    expect(disallowedOf(args)).toContain("PowerShell")
    expect(args.join(" ")).not.toContain("ade-msg")
    // Lean anyway: no settings file can bring back an allowed command.
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("")
    // Writes stay out of the paths that run code later.
    expect(disallowedOf(args)).toContain("Write(./.git/**)")
  })

  /*
   * G5 review, M1: `claude -p` cannot have each command approved, so a list
   * of allowed commands was an approval in advance (`npm *` runs any script).
   * In V1 a Claude bot from a chat never has a shell.
   */
  test("Claude con i comandi da remoto accesi: ancora niente shell", () => {
    const { args } = turnCommand(runnerById("claude"), { bot: mine, message: "x", remote: on })
    expect(allowedOf(args).filter((tool) => /Bash|PowerShell/.test(tool))).toEqual([])
    expect(disallowedOf(args)).toContain("Bash")
    expect(disallowedOf(args)).toContain("PowerShell")
  })

  test("Codex: sola lettura anche per un bot che nel pannello scrive, e anche con i comandi accesi", () => {
    for (const remote of [off, on]) {
      const { args } = turnCommand(runnerById("codex"), { bot: mine, message: "x", remote })
      expect(args).toContain('sandbox_mode="read-only"')
      expect(args.join(" ")).not.toContain("workspace-write")
    }
  })

  test("nikcli: la shell negata, o chiesta per ogni comando quando i comandi sono accesi", () => {
    expect(turnCommand(runnerById("nikcli"), { bot: mine, message: "x", remote: off }).flags).toEqual(["no-project-config", "remote-no-shell"])
    expect(turnCommand(runnerById("nikcli"), { bot: { ...bot, scope: "project" }, message: "x", remote: off }).flags).toEqual(["remote-no-shell"])
    expect(turnCommand(runnerById("nikcli"), { bot: mine, message: "x", remote: on }).flags).toEqual([
      "no-project-config",
      "remote-ask-shell",
    ])
  })

  test("un turno del pannello resta com'era", () => {
    expect(allowedOf(turnCommand(runnerById("claude"), { bot: mine, message: "x", lean: true }).args)).toContain("Bash")
    expect(turnCommand(runnerById("nikcli"), { bot: mine, message: "x" }).flags).toEqual(["no-project-config", "bot-no-shell"])
  })

  test("M1: ogni turno su nikcli ha un solo flag sui permessi, che nega la shell o la chiede", () => {
    const withBlock = ["bot-no-shell", "bot-ask-shell", "bot-ask-outside", "remote-ask-shell", "remote-no-shell"]
    const cases = [
      { bot: mine, message: "x" },
      { bot: { ...bot, scope: "project" as const }, message: "x" },
      { bot: mine, message: "x", approvals: true },
      { bot: { ...mine, disabledTools: ["bash"] }, message: "x", approvals: true },
      { bot: mine, message: "x", remote: on },
    ]
    for (const spec of cases) {
      const flags = turnCommand(runnerById("nikcli"), spec).flags ?? []
      // Exactly one: two flags on NIKCLI_PERMISSION are refused by Rust.
      expect(flags.filter((flag) => withBlock.includes(flag))).toHaveLength(1)
    }
    expect(turnCommand(runnerById("nikcli"), { bot: mine, message: "x", remote: off }).flags).not.toContain("bot-no-shell")
  })
})

describe("abbonamento o chiave", () => {
  test("plan mette account-plan e nessuna chiave; key mette il nome; nikcli non ha il flag", () => {
    const plan = turnCommand(runnerById("claude"), { bot, message: "x" })
    expect(plan.flags).toEqual(["account-plan"])
    expect(plan.secrets).toBeUndefined()
    const key = turnCommand(runnerById("codex"), { bot, message: "x", account: { mode: "key", key: "lavoro" } })
    expect(key.flags).toEqual(["account-key"])
    expect(key.secrets).toEqual(["lavoro"])
    const nik = turnCommand(runnerById("nikcli"), { bot, message: "x", account: { mode: "key", key: "lavoro" } })
    expect(nik.flags ?? []).not.toContain("account-key")
    expect(nik.flags ?? []).not.toContain("account-plan")
    expect(nik.secrets).toBeUndefined()
    const missing = turnCommand(runnerById("claude"), { bot, message: "x", account: { mode: "key", key: "" } })
    expect(missing.flags).toEqual(["account-key"])
    expect(missing.secrets).toBeUndefined()
  })
})

describe("il costo di un turno", () => {
  test("Claude Code e Codex non mostrano dollari: il numero della CLI non è un addebito", () => {
    for (const runnerId of ["claude", "codex"]) {
      const line = spendLine({ runnerId, model: "opus", tokens: 1200, costUsd: 0.42 })
      expect(line.kind).toBe("plan")
      expect(line.usd).toBeUndefined()
      expect(JSON.stringify(line)).not.toContain("$")
    }
  })

  test("nikcli mostra il costo del turno, e un modello :free no", () => {
    const paid = spendLine({ runnerId: "nikcli", model: "openai/gpt-4o", tokens: 800, costUsd: 0.04 })
    expect(paid).toMatchObject({ kind: "api", model: "openai/gpt-4o", usd: "$0.04" })
    const free = spendLine({ runnerId: "nikcli", model: "google/gemini-2.0-flash:free", tokens: 800, costUsd: 0.5 })
    expect(free.kind).toBe("free")
    expect(free.usd).toBeUndefined()
    const unnamed = spendLine({ runnerId: "nikcli", tokens: 10, costUsd: 0.004 })
    expect(unnamed.kind).toBe("metered")
    expect(unnamed.usd).toBe("$0.004")
    expect(spendLine({ runnerId: "nikcli", model: "openai/gpt-4o", tokens: 1, costUsd: 0 }).usd).toBeUndefined()
  })

  test("con la chiave Claude mostra i dollari, Codex i token e nessun dollaro, l'abbonamento niente", () => {
    const claude = spendLine({
      runnerId: "claude",
      model: "opus",
      tokens: 12,
      costUsd: 0.04,
      account: { mode: "key", key: "lavoro" },
    })
    expect(claude).toMatchObject({ kind: "api", usd: "$0.04" })
    const codex = spendLine({
      runnerId: "codex",
      model: "gpt-5.5",
      tokens: 12,
      costUsd: 0.04,
      account: { mode: "key", key: "lavoro" },
    })
    expect(codex.kind).toBe("api")
    expect(codex.usd).toBeUndefined()
    expect(codex.unreported).toBe(true)
    expect(JSON.stringify(codex)).not.toContain("$")
    const plan = spendLine({ runnerId: "claude", model: "opus", tokens: 12, costUsd: 0.42, account: { mode: "plan" } })
    expect(plan.kind).toBe("plan")
    expect(plan.usd).toBeUndefined()
    expect(plan.unreported).toBeUndefined()
    expect(JSON.stringify(plan)).not.toContain("$")
  })

  test("il totale di un filo non mescola i modi", () => {
    const runner = runnerById("claude")
    const line = (cost: number) =>
      `{"type":"result","is_error":false,"session_id":"s","total_cost_usd":${cost},"usage":{"input_tokens":1,"output_tokens":1}}`
    let talk = applyRunnerLine(runner, { ...sendMessage(emptyTalk(), "a", 1), turnMode: "plan" }, line(0.04), 2)
    talk = applyRunnerLine(runner, { ...sendMessage(talk, "b", 3), turnMode: "api" }, line(0.01), 4)
    expect(talk.lastTurn).toMatchObject({ mode: "api", costUsd: 0.01 })
    expect(talk.byMode?.plan?.costUsd).toBe(0.04)
    expect(talk.byMode?.api?.costUsd).toBe(0.01)
    expect(talk.costUsd).toBeCloseTo(0.05)
    const restored = parseTalk(serializeTalk(talk))
    expect(restored.byMode?.plan?.costUsd).toBe(0.04)
    expect(restored.byMode?.api?.costUsd).toBe(0.01)
    expect(restored.lastTurn?.mode).toBe("api")
    expect(restored.turnMode).toBeUndefined()
  })

  test("i dollari hanno tre cifre sotto il centesimo e due sopra", () => {
    expect(formatUsd(0.009)).toBe("$0.009")
    expect(formatUsd(0.01)).toBe("$0.01")
    expect(formatUsd(1.2)).toBe("$1.20")
  })

  test("l'ultimo turno di Claude Code tiene il modello dell'init e solo i token di quel result", () => {
    const talk = fold("claude", [
      '{"type":"system","subtype":"init","session_id":"s","model":"claude-sonnet-5"}',
      '{"type":"result","is_error":false,"session_id":"s","total_cost_usd":0.04,"usage":{"input_tokens":10,"output_tokens":2}}',
    ])
    expect(talk.tokens).toBe(12)
    expect(talk.lastTurn).toEqual({ model: "claude-sonnet-5", tokens: 12, costUsd: 0.04 })
    const again = fold("claude", [
      '{"type":"result","is_error":false,"session_id":"s","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1}}',
    ])
    const second = applyRunnerLine(
      runnerById("claude"),
      sendMessage(talk, "ancora", 2),
      '{"type":"result","is_error":false,"session_id":"s","model":"claude-haiku-4-5","total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":1}}',
      3,
    )
    expect(second.tokens).toBe(16)
    expect(second.costUsd).toBeCloseTo(0.05)
    expect(second.lastTurn).toEqual({ model: "claude-haiku-4-5", tokens: 4, costUsd: 0.01 })
    expect(again.lastTurn?.tokens).toBe(2)
  })

  test("Codex tiene il modello di thread.started sull'ultimo turno", () => {
    const talk = fold("codex", [
      '{"type":"thread.started","thread_id":"t1","model":"gpt-5.5"}',
      '{"type":"turn.completed","usage":{"input_tokens":3,"cached_input_tokens":1,"output_tokens":1}}',
    ])
    expect(talk.tokens).toBe(4)
    expect(talk.lastTurn).toEqual({ model: "gpt-5.5", tokens: 4, costUsd: 0 })
  })

  test("Genera con nikcli: senza modello è il predefinito, a pagamento; :free no", () => {
    expect(generationSpend()).toEqual({ model: "", paid: true })
    expect(generationSpend("  ")).toEqual({ model: "", paid: true })
    expect(generationSpend("openai/gpt-4o")).toEqual({ model: "openai/gpt-4o", paid: true })
    expect(generationSpend("google/gemini-2.0-flash:free")).toEqual({ model: "google/gemini-2.0-flash:free", paid: false })
  })
})


/* B8c: Claude Code cannot ask mid-turn, so what would be a question is a refusal. */
describe("B8c: Claude Code e le approvazioni", () => {
  const mine: AgentFile = { ...bot, scope: "global" }
  const refusedOf = (args: readonly string[]) => {
    const at = args.indexOf("--disallowedTools")
    return at < 0 ? [] : (args[at + 1] ?? "").split(",")
  }

  test("un bot del pannello: la lista di blocco sempre, i pericoli tranne quelli su «Sempre»", () => {
    const { args } = turnCommand(runnerById("claude"), { bot: mine, message: "x", lean: true, approvals: true, always: ["gitRewrite"] })
    const refused = refusedOf(args)
    expect(refused).toContain("Bash(rm -rf /:*)")
    expect(refused).toContain("PowerShell(Format-Volume:*)")
    expect(refused).toContain("Bash(rm -rf:*)")
    expect(refused).not.toContain("Bash(git push --force:*)")
    // Still one argument, well inside a command line.
    expect(args.join(" ").length).toBeLessThan(7000)
  })

  test("la voce (nessuna approvazione): solo la lista di blocco", () => {
    const refused = refusedOf(turnCommand(runnerById("claude"), { bot: mine, message: "x", lean: true }).args)
    expect(refused).toContain("Bash(shutdown:*)")
    expect(refused).not.toContain("Bash(rm -rf:*)")
  })

  test("un bot senza shell non ne ha bisogno: la shell è già rifiutata tutta", () => {
    const noShell = { ...mine, disabledTools: ["bash"] }
    const refused = refusedOf(turnCommand(runnerById("claude"), { bot: noShell, message: "x", approvals: true }).args)
    expect(refused).toContain("Bash")
    expect(refused).not.toContain("Bash(shutdown:*)")
  })

  test("il rifiuto torna nel thread col suo motivo; un pericolo offre «Sempre», un blocco no", () => {
    const denied = fold("claude", [
      '{"type":"result","is_error":false,"session_id":"s","permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_1","tool_input":{"command":"git push --force origin main"}}]}',
    ])
    expect(denied.offer).toMatchObject({ always: ["gitRewrite"], command: "git push --force origin main" })
    expect(denied.messages.at(-1)!.text).toContain("git push --force origin main")
    // Not mistaken for a protected folder, nor for a tool to turn on.
    expect(denied.messages.some((m) => m.text.includes(".git,"))).toBe(false)
    const blocked = fold("claude", [
      '{"type":"result","is_error":false,"session_id":"s","permission_denials":[{"tool_name":"PowerShell","tool_input":{"command":"Format-Volume -DriveLetter D"}}]}',
    ])
    expect(blocked.offer).toBeUndefined()
    expect(blocked.messages.at(-1)!.text).toContain("Format-Volume -DriveLetter D")
  })
})

describe("a turn nobody watches (B11, a routine)", () => {
  test("no shell on any runner: nikcli without its shell, Codex read-only", () => {
    const own = { ...bot, scope: "global" as const }
    const nikcli = turnCommand(runnerById("nikcli"), { bot: own, message: "x", approvals: true, unattended: true })
    expect(nikcli.flags).toEqual(["no-project-config", "bot-no-shell"])
    const codex = turnCommand(runnerById("codex"), { bot: { ...own, runner: "codex" }, message: "x", unattended: true })
    expect(codex.args.join(" ")).toContain('sandbox_mode="read-only"')
    const claude = turnCommand(runnerById("claude"), { bot: { ...own, runner: "claude" }, message: "x", lean: true, unattended: true })
    const allowed = claude.args[claude.args.indexOf("--allowedTools") + 1] ?? ""
    expect(allowed).not.toContain("Bash")
    expect(allowed).not.toContain("ade-msg")
  })
})
