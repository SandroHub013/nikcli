/**
 * Messages between sessions: who a message is for, and how it lands.
 *
 * The transport is in `src-tauri/src/mailbox.rs` — `ade-msg` drops a file,
 * the workbench takes it. This module is the part with decisions in it, kept
 * pure so the decisions are tested.
 *
 * Four kinds, modelled on how Claude Code works with its subagents:
 *
 * - `send`  — a note, fire and forget;
 * - `ask`   — a request to an open session; the caller's `ade-msg ask` blocks
 *             until that session answers with `ade-msg reply`, and prints the
 *             answer as its own output, the way a Task tool call returns;
 * - `spawn` — the same, to a session ADE opens for the purpose with the agent
 *             the caller named: a subagent, in its own pane, on any CLI;
 * - `reply` — the answer to an `ask` or a `spawn`, by request id.
 *
 * The request line typed into the recipient carries the reply command, so an
 * agent that has never heard of `ade-msg` can still answer.
 */

export interface MailPane {
  id: string
  title: string
  agent?: string
  status?: string
}

/** `token` is what proves `from`; see {@link verifySender}. */
export type Message = { from: string; token?: string; text: string } & (
  | { kind: "send" | "ask"; to: string }
  | { kind: "spawn"; agent: string }
  | { kind: "reply"; ref: string }
)

/** Longest text delivered. Past this it is a file, and should be sent as a path. */
export const MAX_TEXT = 4000

/** A request id names a file; the same shape `mailbox.rs` accepts. */
export function isRequestId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id)
}

export function parseMessage(body: string): Message | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(body.replace(/^\ufeff/, ""))
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  const str = (key: string) => (typeof record[key] === "string" ? (record[key] as string).trim() : "")
  const from = str("from")
  const token = str("token") || undefined
  const text = typeof record.text === "string" ? record.text : ""
  if (!text.trim()) return undefined
  const kind = str("kind") || "send"

  if (kind === "send" || kind === "ask") {
    const to = str("to")
    return to ? { kind, from, token, to, text } : undefined
  }
  if (kind === "spawn") {
    const agent = str("agent")
    return agent ? { kind, from, token, agent, text } : undefined
  }
  if (kind === "reply") {
    const ref = str("ref")
    return isRequestId(ref) ? { kind, from, token, ref, text } : undefined
  }
  return undefined
}

/**
 * The message with `from` kept only if its token is that pane's.
 *
 * A pane id is public — `ade-msg list` prints every one — so without this
 * any session could sign as another, and answer a request made to it. An
 * unproven sender is not refused, only anonymous: a note still arrives, it
 * just cannot be answered, and a reply to a known request is refused.
 */
export function verifySender<M extends Message>(message: M, tokenOf: (paneId: string) => string | undefined): M {
  const expected = message.from ? tokenOf(message.from) : undefined
  const proven = expected !== undefined && message.token === expected
  return proven ? message : { ...message, from: "" }
}

/** `claude-code` answers to "claude"; ids are compared without that suffix. */
function agentName(agent: string | undefined): string {
  return (agent ?? "").toLowerCase().replace(/-code$/, "")
}

export type Resolution = { pane: MailPane } | { error: string }

/**
 * One pane for what the sender wrote, tried from most to least precise:
 * the pane id, its number in `ade-msg list`, its exact title, the agent's
 * name, a piece of the title. Ambiguity is an error, never a guess — a
 * message delivered to the wrong session is worse than one refused.
 */
export function resolveTarget(panes: readonly MailPane[], to: string, fromId?: string): Resolution {
  const wanted = to.trim().replace(/^#/, "")
  const lower = wanted.toLowerCase()

  const byId = panes.find((pane) => pane.id === wanted)
  if (byId) return { pane: byId }

  if (/^\d+$/.test(wanted)) {
    const pane = panes[Number(wanted) - 1]
    return pane ? { pane } : { error: `nessuna sessione numero ${wanted} (ce ne sono ${panes.length})` }
  }

  const pick = (matches: MailPane[], what: string): Resolution | undefined => {
    // The sender is never its own recipient by a loose match.
    const others = matches.filter((pane) => pane.id !== fromId)
    if (others.length === 1) return { pane: others[0]! }
    if (others.length > 1) {
      return {
        error: `"${wanted}" corrisponde a ${others.length} sessioni (${what}): ${others
          .map((pane) => `${panes.indexOf(pane) + 1} ${pane.title}`)
          .join(", ")} — usa il numero`,
      }
    }
    return undefined
  }

  return (
    pick(panes.filter((pane) => pane.title.toLowerCase() === lower), "titolo") ??
    pick(panes.filter((pane) => agentName(pane.agent) === agentName(wanted)), "agente") ??
    pick(panes.filter((pane) => pane.title.toLowerCase().includes(lower)), "titolo") ?? {
      error: `nessuna sessione "${wanted}". Sessioni: ${panes.map((pane, i) => `${i + 1} ${pane.title}`).join(", ") || "nessuna"}`,
    }
  )
}

/**
 * The agent a `spawn` names, among the ones ADE can start: by id, by id
 * without `-code`, or by label ("Claude Code", "codex", "claude").
 */
export function resolveAgent(
  agents: readonly { id: string; label: string }[],
  name: string,
): { id: string } | { error: string } {
  const wanted = name.trim().toLowerCase()
  const hit =
    agents.find((agent) => agent.id.toLowerCase() === wanted) ??
    agents.find((agent) => agentName(agent.id) === agentName(wanted)) ??
    agents.find((agent) => agent.label.toLowerCase() === wanted)
  return hit
    ? { id: hit.id }
    : { error: `nessun agente "${name}". Agenti: ${agents.map((agent) => agent.id).join(", ")}` }
}

/** Control characters out, line breaks to spaces, and a ceiling on length. */
function oneLine(text: string): string {
  const clean = text
    .replace(/\r?\n|\r/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}… [troncato]` : clean
}

function who(sender: MailPane | undefined): string {
  return sender ? `"${sender.title}"${sender.agent ? ` (${sender.agent})` : ""}` : "una sessione ADE"
}

/**
 * A note, typed into the recipient's terminal.
 *
 * Control characters are removed — an escape sequence in a message would be
 * a keystroke in somebody else's terminal — and line breaks become spaces,
 * because Enter is what submits the line and a message must arrive whole.
 */
export function formatDelivery(message: { text: string }, sender: MailPane | undefined): string {
  const reply = sender ? ` — per rispondere: ade-msg send ${sender.id} "<testo>"` : ""
  return `[Messaggio da ${who(sender)}]: ${oneLine(message.text)}${reply}`
}

/**
 * A request, typed into the session that has to do it.
 *
 * The reply command is the last thing on the line on purpose: it is what the
 * caller is blocked on, and an answer given in the conversation instead of
 * through `ade-msg reply` never reaches it.
 */
export function formatRequest(id: string, text: string, sender: MailPane | undefined): string {
  return (
    `[Richiesta ${id} da ${who(sender)}]: ${oneLine(text)} — ` +
    `${who(sender)} è in attesa: quando hai finito rispondi con ade-msg reply ${id} "<risultato completo>"`
  )
}

/** The answer to a request, typed into the caller when nothing was waiting for it any more. */
export function formatLateReply(ref: string, text: string, replier: MailPane | undefined): string {
  return `[Risposta alla richiesta ${ref} da ${who(replier)}]: ${oneLine(text)}`
}

/** What `ade-msg list` prints: number, id, agent, state, title. */
export function sessionsTable(panes: readonly MailPane[]): string {
  if (panes.length === 0) return "nessuna sessione aperta\n"
  const rows = panes.map((pane, i) => [
    String(i + 1),
    pane.id,
    pane.agent ?? "-",
    pane.status ?? "-",
    pane.title,
  ])
  const widths = [0, 1, 2, 3].map((col) => Math.max(...rows.map((row) => row[col]!.length)))
  const lines = rows.map((row) =>
    row.map((cell, col) => (col < 4 ? cell.padEnd(widths[col]!) : cell)).join("  "),
  )
  return `${lines.join("\n")}\n\n${USAGE}`
}

/** What `ade-msg agents` prints: the CLIs a `spawn` can start. */
export function agentsTable(agents: readonly { id: string; label: string }[]): string {
  return `${agents.map((agent) => `${agent.id.padEnd(14)}${agent.label}`).join("\n")}\n\nuso: ade-msg spawn <agente> "<compito>"\n`
}

export const USAGE =
  "uso:\n" +
  "  ade-msg send  <sessione> \"<testo>\"      nota, non aspetta risposta\n" +
  "  ade-msg ask   <sessione> \"<richiesta>\"  aspetta la risposta e la stampa\n" +
  "  ade-msg spawn <agente>   \"<compito>\"    apre una nuova sessione (subagent) e aspetta il risultato\n" +
  "  ade-msg reply <id> \"<risultato>\"        risponde a una richiesta ricevuta\n" +
  "  ade-msg wait  <id>                      riprende l'attesa di una richiesta ancora in corso\n" +
  "  ade-msg agents | whoami\n" +
  "<sessione> = numero, id, titolo o nome dell'agente; ask/spawn/wait accettano --timeout <secondi>\n"
