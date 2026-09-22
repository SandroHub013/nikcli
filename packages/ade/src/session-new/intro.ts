/**
 * Telling each agent, as it starts, that it can talk to the other sessions.
 *
 * `ade-msg` is on every session's PATH (`src-tauri/src/mailbox.rs`), and an
 * agent that does not know about it never uses it. The notice goes where the
 * CLI keeps its instructions, not into the conversation: typed as a first
 * message it would cost a turn, answer with a greeting, and land in every
 * session whether or not the user ever wants two agents to talk.
 *
 * Where the flag was read off `--help`:
 *
 *   claude   --append-system-prompt <prompt>
 *   prime    --append-system-prompt <text>
 *   pi       --append-system-prompt <text>
 *   codex    -c developer_instructions=<toml string>   (key present in 0.154)
 *
 * agy, opencode, nikcli, kimi and hermes have no such flag. For them the
 * notice rides in front of the opening task when there is one; a session
 * started with no task learns it from the first message it receives, which
 * carries the reply command.
 *
 * The text avoids `" & | < > ^ %`: on Windows these CLIs are `.cmd` shims, and
 * an argument crosses cmd.exe on its way to the program.
 */

/*
 * Short on purpose: it rides in every session's system prompt, including the
 * many that never message anyone, and each request repeats the reply contract
 * anyway. What is rarely needed (kv, memory, fork, stats, close) is one
 * `ade-msg help` away rather than paid for up front.
 *
 * The one habit worth its words is not polling. A reply that nobody is
 * waiting for is typed into the caller by ADE, so `--no-wait` and carrying on
 * costs nothing, while every `wait` that times out is a whole model turn
 * re-reading the context.
 */
export const INTRO_TEXT =
  "Sei una sessione dentro ADE, con altre sessioni di agenti. Dalla shell usa ade-msg: " +
  "ade-msg list per le sessioni aperte; ade-msg ask SESSIONE TESTO per una richiesta; " +
  "ade-msg spawn AGENTE COMPITO per aprire una sessione nuova (--name NOME, --worktree se deve modificare file, --model ID per compiti semplici); " +
  "ade-msg send SESSIONE TESTO per una nota. SESSIONE e numero, id, titolo o agente. " +
  "Non fare polling: con --no-wait continua il tuo lavoro o chiudi il turno, la risposta ti arriva da sola come [Risposta alla richiesta ...]; " +
  "usa ade-msg wait ID solo se ti serve subito, e non ripeterlo in ciclo. " +
  "Delega compiti grandi, non piccoli, e chiedi sintesi brevi con i dettagli su file. " +
  "A ogni [Richiesta ID ...] rispondi con ade-msg reply ID seguito dalla sintesi; se sei bloccata usa ade-msg update ID bloccata seguito dal motivo. " +
  "Se esiste .ade/memory.md del progetto leggilo prima di esplorare. Un avviso che dice ade-msg inbox si legge con quel comando. Tutti gli altri comandi: ade-msg help. " +
  "Usalo quando l'utente lo chiede o quando coordinarti serve al compito."

/*
 * One line more, by model, paid once per session and never per message.
 *
 * The reply contract stays the same for every model: it is the protocol, and
 * Master reads it the same way from everyone. What differs between models,
 * by their own prompting guides (S72), belongs in the system prompt:
 *
 *   Opus 5    runs long whatever the effort, verifies on its own (so a
 *             "ricontrolla" doubles the work), widens scope, and delegates
 *             readily;
 *   Sonnet 5  is literal, applies an instruction to the one item named, and
 *             takes "only what is doubtful" as a reason to report less;
 *   Fable 5.1 formats less than earlier models, so anti-formatting rules cut
 *             structure the content needs, and adds fixes nobody asked for.
 *
 * The model is read off the launch line (`modelIn`, `session/orchestra.ts`):
 * a pane without one runs the CLI's default, which ADE does not know, and
 * gets no line. Only claude-code gets a line at all: the lines are written
 * for Claude models, and the review showed that without the check in code a
 * Prime or Codex pane whose model happened to contain "sonnet" would have
 * been handed Sonnet's line.
 */
export const MODEL_LINES: readonly { match: RegExp; line: string }[] = [
  {
    match: /opus/i,
    /*
     * Not "open no sessions": the notice above tells every session to
     * delegate big tasks and not small ones, and a flat ban would contradict
     * it for the one model that reads both. The Opus 5 guide does not ban
     * delegation either, it caps it: big and genuinely independent work, one
     * session rather than several, never to check one's own work. The hard
     * cap, where one is wanted, is the spawn depth in the request contract.
     */
    line:
      "Rispondi entro il tetto di righe del contratto. Non verificare o ricontrollare oltre quanto ti e chiesto. " +
      "Consegna quello che e chiesto, alla portata intesa. Se deleghi, una sessione sola e solo per un lavoro grande e indipendente, mai per controllare il tuo.",
  },
  {
    match: /sonnet/i,
    line:
      "Le istruzioni valgono per tutti gli elementi che nominano, non solo il primo. " +
      "Riporta tutto cio che trovi, anche il dubbio e il minore, con gravita e confidenza: il filtro lo fa chi legge.",
  },
  {
    match: /fable|mythos/i,
    line:
      "Usa elenchi e grassetto quando aiutano a capire. " +
      "Tieni modifiche e test a cio che il compito chiede; il resto segnalalo come seguito.",
  },
]

/** The notice, plus the line for the model when the pane is claude-code and the launch line names one ADE knows. */
export function introText(agentId: string, model?: string): string {
  if (agentId !== "claude-code") return INTRO_TEXT
  const found = model ? MODEL_LINES.find((entry) => entry.match.test(model)) : undefined
  return found ? `${INTRO_TEXT} ${found.line}` : INTRO_TEXT
}

/** Arguments that put the notice in the CLI's instructions, or none. */
export function introArgs(agentId: string, text = INTRO_TEXT): string[] {
  switch (agentId) {
    case "claude-code":
    case "prime":
    case "pi":
      return ["--append-system-prompt", text]
    case "codex":
      // A TOML basic string; JSON's escaping is a subset of it.
      return ["-c", `developer_instructions=${JSON.stringify(text)}`]
    default:
      return []
  }
}

/**
 * The opening task, with the notice in front for a CLI that has no flag.
 *
 * Empty stays empty: typing the notice alone would start a turn nobody asked
 * for.
 */
export function withIntro(agentId: string, task: string, text = INTRO_TEXT): string {
  if (!task.trim() || introArgs(agentId, text).length > 0) return task
  return `(${text}) ${task}`
}

/** The command line as the transcript shows it: the notice folded to a mark. */
export function displayArgs(args: readonly string[], text = INTRO_TEXT): string[] {
  // The model's line, when there is one, follows the mark and stays readable.
  return args.map((arg) => arg.replace(text, "…ade-msg…").replace(JSON.stringify("…ade-msg…"), "…ade-msg…"))
}
