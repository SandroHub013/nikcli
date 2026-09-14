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
  /** The project the session works in; sessions are listed and found by it. */
  project?: string
}

/** `token` is what proves `from`; see {@link verifySender}. */
export type Message = { from: string; token?: string; text: string } & (
  | { kind: "send" | "ask"; to: string }
  /** `autoClose`: the session is closed as soon as it has replied. */
  | { kind: "spawn"; agent: string; autoClose: boolean }
  | { kind: "reply"; ref: string }
  /** Closes a session the sender started with `spawn`. `text` is empty. */
  | { kind: "close"; to: string }
  /** Withdraws a request the sender made. `text` is empty. */
  | { kind: "cancel"; ref: string }
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
  const kind = str("kind") || "send"

  // The two that carry no text.
  if (kind === "close") {
    const to = str("to")
    return to ? { kind, from, token, to, text: "" } : undefined
  }
  if (kind === "cancel") {
    const ref = str("ref")
    return isRequestId(ref) ? { kind, from, token, ref, text: "" } : undefined
  }

  if (!text.trim()) return undefined
  if (kind === "send" || kind === "ask") {
    const to = str("to")
    return to ? { kind, from, token, to, text } : undefined
  }
  if (kind === "spawn") {
    const agent = str("agent")
    return agent ? { kind, from, token, agent, autoClose: record.close === true, text } : undefined
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

const NO_PROJECT = "senza progetto"

function projectOf(pane: MailPane): string {
  return pane.project?.trim() || NO_PROJECT
}

/**
 * The panes with each project's sessions together, projects in the order they
 * first appear. The numbers `ade-msg list` prints are positions in this order,
 * so everything that numbers panes goes through it.
 */
export function byProject(panes: readonly MailPane[]): MailPane[] {
  const groups = new Map<string, MailPane[]>()
  for (const pane of panes) {
    const key = projectOf(pane)
    groups.set(key, [...(groups.get(key) ?? []), pane])
  }
  return [...groups.values()].flat()
}

/**
 * One pane for what the sender wrote, tried from most to least precise:
 * the pane id, its number in `ade-msg list`, its exact title, the agent's
 * name, a piece of the title.
 *
 * Sessions are found by project. `progetto/nome` looks only inside that
 * project (`progetto/2` is the second session there); a plain name matching
 * in several projects goes to the one in the sender's own project, which is
 * almost always the one meant — "claude" from a codex working on nikcli is
 * the claude working on nikcli. Ambiguity left after that is an error, never
 * a guess: a message delivered to the wrong session is worse than one refused.
 */
export function resolveTarget(panes: readonly MailPane[], to: string, fromId?: string): Resolution {
  const ordered = byProject(panes)
  const trimmed = to.trim().replace(/^#/, "")

  const byId = ordered.find((pane) => pane.id === trimmed)
  if (byId) return { pane: byId }

  const label = (pane: MailPane) => `${ordered.indexOf(pane) + 1} ${pane.title} [${projectOf(pane)}]`

  // `progetto/nome`: what comes before the last slash names a project.
  let scope = ordered
  let wanted = trimmed
  const slash = trimmed.lastIndexOf("/")
  if (slash > 0) {
    const name = trimmed.slice(0, slash).trim().toLowerCase()
    const inProject = ordered.filter((pane) => projectOf(pane).toLowerCase() === name)
    if (inProject.length === 0) {
      const projects = [...new Set(ordered.map(projectOf))].join(", ") || "nessuno"
      return { error: `nessun progetto "${trimmed.slice(0, slash)}". Progetti: ${projects}` }
    }
    scope = inProject
    wanted = trimmed.slice(slash + 1).trim().replace(/^#/, "")
  }
  const lower = wanted.toLowerCase()

  if (/^\d+$/.test(wanted)) {
    const pane = scope[Number(wanted) - 1]
    return pane ? { pane } : { error: `nessuna sessione numero ${wanted} (ce ne sono ${scope.length})` }
  }

  const home = ordered.find((pane) => pane.id === fromId)
  const pick = (matches: MailPane[], what: string): Resolution | undefined => {
    // The sender is never its own recipient by a loose match.
    let others = matches.filter((pane) => pane.id !== fromId)
    if (others.length > 1 && home) {
      const near = others.filter((pane) => projectOf(pane) === projectOf(home))
      if (near.length > 0) others = near
    }
    if (others.length === 1) return { pane: others[0]! }
    if (others.length > 1) {
      return {
        error: `"${wanted}" corrisponde a ${others.length} sessioni (${what}): ${others.map(label).join(", ")} — usa il numero o progetto/nome`,
      }
    }
    return undefined
  }

  return (
    pick(scope.filter((pane) => pane.title.toLowerCase() === lower), "titolo") ??
    pick(scope.filter((pane) => agentName(pane.agent) === agentName(wanted)), "agente") ??
    pick(scope.filter((pane) => pane.title.toLowerCase().includes(lower)), "titolo") ?? {
      error: `nessuna sessione "${trimmed}". Sessioni: ${ordered.map(label).join(", ") || "nessuna"}`,
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
    `${who(sender)} è in attesa: quando hai finito rispondi con ade-msg reply ${id} "<risultato completo>" ` +
    `(se è lungo scrivilo in un file e usa ade-msg reply ${id} --file <percorso>)`
  )
}

/** Typed into a session that went quiet with a request still unanswered. */
export function formatNudge(id: string, caller: MailPane | undefined): string {
  return (
    `[Promemoria ade-msg] ${who(caller)} aspetta ancora la risposta alla richiesta ${id}: ` +
    `se hai finito rispondi con ade-msg reply ${id} "<risultato completo>" (o --file <percorso>); ` +
    `se non puoi farla rispondi comunque spiegando perché`
  )
}

/** Typed into a session whose request was withdrawn. */
export function formatCancel(id: string, caller: MailPane | undefined): string {
  return `[Richiesta ${id} annullata da ${who(caller)}]: interrompi quel lavoro, non serve più rispondere`
}

// ---------------------------------------------------------------------------
// Requests in flight: what an orchestrating session is waiting on
// ---------------------------------------------------------------------------

export interface OpenRequest {
  id: string
  kind: "ask" | "spawn"
  /** The pane that asked; empty when the sender was not proven. */
  from: string
  /** The pane that has to answer. */
  to: string
  /** When it was delivered or the session was spawned, epoch ms. */
  at: number
  /** The first words of the request, for `ade-msg status`. */
  brief: string
  /** Close the answering session once it has replied (`spawn --close`). */
  autoClose?: boolean
  /** Reminders already typed, and when the last one was. */
  nudges?: number
  nudgedAt?: number
}

export type RequestState = "in corso" | "attende un permesso" | "sessione chiusa" | "in avvio"

/** How long a freshly spawned session has to come up before "not running" means closed. */
export const SPAWN_GRACE_MS = 30_000

export function requestState(
  request: OpenRequest,
  target: { running: boolean; permissionPending: boolean },
  now: number,
): RequestState {
  if (!target.running) return now - request.at < SPAWN_GRACE_MS ? "in avvio" : "sessione chiusa"
  return target.permissionPending ? "attende un permesso" : "in corso"
}

/** A request older than this, in a session silent for {@link NUDGE_QUIET_MS}, gets a reminder. */
export const NUDGE_AFTER_MS = 60_000
export const NUDGE_QUIET_MS = 45_000
export const NUDGE_GAP_MS = 120_000
export const MAX_NUDGES = 2

/**
 * Whether to remind a session that someone is blocked on it.
 *
 * The one way a request is lost for good is an agent that answers in its own
 * conversation instead of with `ade-msg reply`: it finishes, goes quiet, and
 * the caller waits for a timeout. A TUI at work repaints constantly, so a
 * session with no output for 45 s is one that has stopped — that is when a
 * reminder costs nothing and saves the request. Never while a permission
 * prompt stands (Enter would answer it), and at most twice.
 */
export function shouldNudge(
  request: OpenRequest,
  target: { running: boolean; permissionPending: boolean; lastOutputAt?: number },
  now: number,
): boolean {
  if (!target.running || target.permissionPending) return false
  if ((request.nudges ?? 0) >= MAX_NUDGES) return false
  if (now - request.at < NUDGE_AFTER_MS) return false
  if (request.nudgedAt !== undefined && now - request.nudgedAt < NUDGE_GAP_MS) return false
  return target.lastOutputAt === undefined || now - target.lastOutputAt >= NUDGE_QUIET_MS
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`
}

/** What `ade-msg status` prints: every request still waiting for an answer. */
export function requestsTable(
  requests: readonly OpenRequest[],
  panes: readonly MailPane[],
  stateOf: (request: OpenRequest) => RequestState,
  now: number,
): string {
  if (requests.length === 0) return "nessuna richiesta in corso\n"
  const title = (id: string) => (id ? panes.find((pane) => pane.id === id)?.title ?? id : "anonima")
  const rows = requests.map((request) => [
    request.id,
    request.kind + (request.autoClose ? "+close" : ""),
    age(now - request.at),
    stateOf(request),
    `${title(request.from)} → ${title(request.to)}`,
    request.brief,
  ])
  const widths = [0, 1, 2, 3].map((col) => Math.max(...rows.map((row) => row[col]!.length)))
  const lines = rows.map((row) => row.map((cell, col) => (col < 4 ? cell.padEnd(widths[col]!) : cell)).join("  "))
  return `${lines.join("\n")}\n\nattendi: ade-msg wait <id> [<id>...] [--any]   annulla: ade-msg cancel <id>\n`
}

/** Requests as saved across a restart; anything malformed is dropped. */
export function parseOpenRequests(text: string | null | undefined): OpenRequest[] {
  if (!text) return []
  try {
    const raw: unknown = JSON.parse(text)
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (entry): entry is OpenRequest =>
        !!entry &&
        typeof entry === "object" &&
        isRequestId((entry as OpenRequest).id) &&
        ((entry as OpenRequest).kind === "ask" || (entry as OpenRequest).kind === "spawn") &&
        typeof (entry as OpenRequest).from === "string" &&
        typeof (entry as OpenRequest).to === "string" &&
        typeof (entry as OpenRequest).at === "number",
    )
  } catch {
    return []
  }
}

/** How many sessions `spawn` may keep open at once, unless the user set another number. */
export const DEFAULT_MAX_SPAWNED = 6

/** The first words of a text, on one line. */
export function briefOf(text: string, length = 60): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > length ? `${flat.slice(0, length)}…` : flat
}

/** The answer to a request, typed into the caller when nothing was waiting for it any more. */
export function formatLateReply(ref: string, text: string, replier: MailPane | undefined): string {
  return `[Risposta alla richiesta ${ref} da ${who(replier)}]: ${oneLine(text)}`
}

/**
 * What `ade-msg list` prints: a heading per project, and under it each
 * session's number, id, agent, state and title. The number is global, so it
 * means the same session whichever project the caller is in.
 */
export function sessionsTable(panes: readonly MailPane[]): string {
  if (panes.length === 0) return "nessuna sessione aperta\n"
  const ordered = byProject(panes)
  const rows = ordered.map((pane, i) => [String(i + 1), pane.id, pane.agent ?? "-", pane.status ?? "-", pane.title])
  const widths = [0, 1, 2, 3].map((col) => Math.max(...rows.map((row) => row[col]!.length)))
  const out: string[] = []
  let current: string | undefined
  ordered.forEach((pane, i) => {
    const project = projectOf(pane)
    if (project !== current) {
      const count = ordered.filter((other) => projectOf(other) === project).length
      if (current !== undefined) out.push("")
      out.push(`progetto ${project} (${count} ${count === 1 ? "sessione" : "sessioni"})`)
      current = project
    }
    out.push(`  ${rows[i]!.map((cell, col) => (col < 4 ? cell.padEnd(widths[col]!) : cell)).join("  ")}`)
  })
  return `${out.join("\n")}\n\n${USAGE}`
}

/** What `ade-msg agents` prints: the CLIs a `spawn` can start. */
export function agentsTable(agents: readonly { id: string; label: string }[]): string {
  return `${agents.map((agent) => `${agent.id.padEnd(14)}${agent.label}`).join("\n")}\n\nuso: ade-msg spawn <agente> "<compito>" [--no-wait] [--close]\n`
}

export const USAGE =
  "uso:\n" +
  "  ade-msg send   <sessione> \"<testo>\"       nota, non aspetta risposta\n" +
  "  ade-msg ask    <sessione> \"<richiesta>\"   aspetta la risposta e la stampa\n" +
  "  ade-msg spawn  <agente> \"<compito>\"       nuova sessione (subagent), aspetta il risultato\n" +
  "  ade-msg reply  <id> \"<risultato>\"         risponde a una richiesta ricevuta\n" +
  "  ade-msg wait   <id> [<id>...] [--any]     aspetta le risposte (tutte, o la prima con --any)\n" +
  "  ade-msg status                          richieste in corso\n" +
  "  ade-msg cancel <id>                     annulla una tua richiesta\n" +
  "  ade-msg close  <sessione>               chiude una sessione avviata da te con spawn\n" +
  "  ade-msg agents | whoami\n" +
  "opzioni:\n" +
  "  --no-wait        ask/spawn: stampa subito l'id, poi usa wait (per lanciare in parallelo)\n" +
  "  --close          spawn: chiude la sessione appena ha risposto\n" +
  "  --file <perc>    ask/spawn/send/reply: il testo è il contenuto del file\n" +
  "  --timeout <sec>  ask/spawn/wait: quanto aspettare (predefinito 110)\n" +
  "<sessione> = numero, id, titolo o nome dell'agente; progetto/nome cerca solo in quel progetto,\n" +
  "  un nome da solo preferisce le sessioni del tuo progetto.\n"
