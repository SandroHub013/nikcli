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

export const INTRO_TEXT =
  "Sei una sessione dentro ADE, accanto ad altre sessioni di agenti che possono usare CLI diverse (Claude Code, Codex e altre). " +
  "Puoi comunicare con loro dalla shell con il comando ade-msg: " +
  "ade-msg list mostra le sessioni aperte di tutti i progetti, divise per progetto, con numero, id, agente e titolo; " +
  "ade-msg ask SESSIONE RICHIESTA manda una richiesta e resta in attesa finche quella sessione risponde, poi stampa la risposta (come un subagent); " +
  "ade-msg spawn AGENTE COMPITO apre una nuova sessione con quell'agente (claude, codex, agy...), le affida il compito e stampa il risultato quando ha finito; " +
  "ade-msg send SESSIONE TESTO manda solo una nota, senza attendere; " +
  "SESSIONE e il numero, l'id, il titolo o il nome dell'agente; un nome da solo cerca prima nel tuo progetto, PROGETTO/NOME cerca in un altro. " +
  "Se ask o spawn stampano ancora in corso, riprendi l'attesa con ade-msg wait ID. " +
  "Per orchestrare lavori in parallelo: lancia piu ade-msg spawn AGENTE COMPITO --no-wait --close (ognuno stampa un id), poi ade-msg wait ID1 ID2 ... per raccogliere tutti i risultati (o --any per il primo); " +
  "ade-msg status mostra le richieste in corso, ade-msg cancel ID ne annulla una, ade-msg close SESSIONE chiude una sessione avviata da te; --file PERCORSO usa il contenuto di un file come testo, utile per compiti o risultati lunghi. " +
  "Le richieste che ricevi iniziano con [Richiesta ID da ...]: fai il lavoro e rispondi SEMPRE con ade-msg reply ID seguito dal risultato completo, perche chi chiede e bloccato finche non rispondi. " +
  "I messaggi [Messaggio da ...] sono note e dicono come rispondere. " +
  "Usalo quando l'utente te lo chiede o quando delegare o coordinarti con un'altra sessione serve al compito."

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
  return args.map((arg) => arg.replace(text, "…ade-msg…").replace(JSON.stringify("…ade-msg…"), "…ade-msg…"))
}
