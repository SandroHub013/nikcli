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
  "ade-msg list mostra le sessioni aperte con numero, id, agente e titolo; " +
  "ade-msg send NUMERO-ID-TITOLO-O-AGENTE TESTO manda un messaggio, che arriva nel terminale di quella sessione come input; " +
  "ade-msg whoami stampa il tuo id. " +
  "I messaggi che ricevi iniziano con [Messaggio da ...] e dicono come rispondere. " +
  "Usalo quando l'utente te lo chiede o quando coordinarti con un'altra sessione serve al compito."

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
