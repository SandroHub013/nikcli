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
  /**
   * `autoClose`: closed once it has replied, unless it has work not yet
   * integrated. `name` titles it; `worktree` gives it its own checkout;
   * `model` picks the model where ADE knows the flag.
   */
  /** `fork`: starts from the sender's own conversation, so its prompt cache carries over. */
  | { kind: "spawn"; agent: string; autoClose: boolean; name?: string; worktree: boolean; model?: string; fork: boolean }
  /** The project's shared key-value store; `text` is the value for `set`, a note for `lock`. */
  | { kind: "kv"; op: KvOpName; key: string; ttl: number; force: boolean }
  /** The project's shared memory file; `type` for `add`, `text` is the entry. */
  | { kind: "memory"; op: "add" | "show"; type: string }
  /** Who owns the file named in `text`, from the team board (`owners.ts`). */
  | { kind: "whoowns" }
  | { kind: "reply"; ref: string }
  /**
   * Not an answer: the session is blocked or needs a decision. The waiter
   * wakes with it and the request stays open.
   */
  | { kind: "update"; ref: string; state: UpdateState }
  /** Closes a session the sender started with `spawn`, and the ones it started. `text` is empty. */
  | { kind: "close"; to: string; force: boolean }
  /**
   * Restarts a session the sender spawned, in the same pane and worktree:
   * its own conversation back unless `fresh`, on another model if `model`.
   */
  | { kind: "relaunch"; to: string; model?: string; fresh: boolean }
  /** Withdraws a request the sender made. `text` is empty. */
  | { kind: "cancel"; ref: string }
)

export const KV_OPS = ["get", "set", "del", "list", "lock", "unlock"] as const
export type KvOpName = (typeof KV_OPS)[number]

/** What `ade-msg update` may say about a request that is not finished. */
export const UPDATE_STATES = ["bloccata", "decisione"] as const
export type UpdateState = (typeof UPDATE_STATES)[number]

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
    return to ? { kind, from, token, to, force: record.force === true, text: "" } : undefined
  }
  if (kind === "relaunch") {
    const to = str("to")
    const model = str("model")
    return to ? { kind, from, token, to, fresh: record.fresh === true, ...(model ? { model } : {}), text: "" } : undefined
  }
  if (kind === "cancel") {
    const ref = str("ref")
    return isRequestId(ref) ? { kind, from, token, ref, text: "" } : undefined
  }
  if (kind === "kv") {
    const op = KV_OPS.find((known) => known === str("op"))
    const key = str("key")
    if (!op || (op !== "list" && !key)) return undefined
    const ttl = typeof record.ttl === "number" && Number.isFinite(record.ttl) ? Math.max(0, Math.floor(record.ttl)) : 0
    if (op === "set" && !text.trim()) return undefined
    return { kind, from, token, op, key, ttl, force: record.force === true, text }
  }
  if (kind === "whoowns") return text.trim() ? { kind, from, token, text: text.trim() } : undefined
  if (kind === "memory") {
    const op = str("op")
    if (op === "show") return { kind, from, token, op, type: "", text: "" }
    if (op === "add" && text.trim()) return { kind, from, token, op, type: str("type"), text }
    return undefined
  }

  if (!text.trim()) return undefined
  if (kind === "send" || kind === "ask") {
    const to = str("to")
    return to ? { kind, from, token, to, text } : undefined
  }
  if (kind === "spawn") {
    const agent = str("agent")
    if (!agent) return undefined
    const name = str("name")
    const model = str("model")
    return {
      kind,
      from,
      token,
      agent,
      autoClose: record.close === true,
      worktree: record.worktree === true,
      fork: record.fork === true,
      ...(name ? { name } : {}),
      ...(model ? { model } : {}),
      text,
    }
  }
  if (kind === "reply") {
    const ref = str("ref")
    return isRequestId(ref) ? { kind, from, token, ref, text } : undefined
  }
  if (kind === "update") {
    const ref = str("ref")
    const state = UPDATE_STATES.find((known) => known === str("state"))
    return isRequestId(ref) && state ? { kind, from, token, ref, state, text } : undefined
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
export function formatRequest(
  id: string,
  text: string,
  sender: MailPane | undefined,
  context: RequestContext = {},
): string {
  const where = context.worktree
    ? ` Lavori nella worktree ${context.worktree.path} (branch ${context.worktree.branch}): modifica solo lì, fai commit sul branch, non toccare il progetto principale.`
    : ""
  const results = context.resultsDir ? `${context.resultsDir}${context.resultsDir.includes("\\") ? "\\" : "/"}${id}.md` : undefined
  /*
   * The contract, and nothing the intro already says. This line is paid for
   * on every request, so the sender is named once and the "you may delegate"
   * sentence appears only where it changes something: at the last level.
   */
  const delegate =
    context.depth !== undefined && context.maxDepth !== undefined && context.depth >= context.maxDepth
      ? " Non avviare altre sessioni: sei all'ultimo livello consentito."
      : ""
  return (
    `[Richiesta ${id} da ${who(sender)}]: ${oneLine(text)} —${where}${delegate} ` +
    `Rispondi con ade-msg reply ${id} "<sintesi>" (max 15 righe: ESITO, FILE toccati, PROBLEMI, PROSSIMO PASSO` +
    (results ? `; dettagli in ${results}` : "") +
    `); se sei bloccata: ade-msg update ${id} bloccata|decisione "<motivo>".`
  )
}

export interface RequestContext {
  worktree?: { path: string; branch: string }
  /** Where detail that does not belong in the reply goes. */
  resultsDir?: string
  /** The answering session's level in the spawn tree, and the most allowed. */
  depth?: number
  maxDepth?: number
}

/** What a waiter prints when a request it waits on is not done but needs its caller. */
export function formatUpdate(id: string, state: UpdateState, text: string, replier: MailPane | undefined): string {
  const what = state === "bloccata" ? "è bloccata" : "chiede una decisione"
  return (
    `[Aggiornamento richiesta ${id}] ${who(replier)} ${what}: ${text.trim()}\n` +
    `La richiesta resta aperta. Rispondi alla sessione con ade-msg send ${replier?.id ?? "<sessione>"} "<risposta>", poi riprendi con ade-msg wait ${id}.`
  )
}

/** Typed into a session that went quiet with a request still unanswered. */
export function formatNudge(id: string, caller: MailPane | undefined): string {
  return `[Promemoria] ${who(caller)} aspetta la richiesta ${id}: ade-msg reply ${id} "<risultato o motivo>"`
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
  /** The last `ade-msg update` about it, until the session replies or works again. */
  update?: { state: UpdateState; text: string; at: number }
  /** When the request line was typed (`ask`); a spawn's is typed by the opening, later. */
  deliveredAt?: number
  /** Extra Enters sent because the line never started a turn. */
  rings?: number
}

export type RequestState = "in corso" | "attende un permesso" | "sessione chiusa" | "in avvio" | "inattiva senza risposta"

/** Whether an agent is in a turn, from its CLI's own hooks. Absent means unknown, never idle. */
export interface Activity {
  state: "busy" | "idle"
  at: number
  /**
   * Where the agent is working, from the hook's own input: a session that
   * moved into another worktree reports it here, and its branch is that one's.
   */
  cwd?: string
}

/** Two paths the same directory, whatever the slashes, case (Windows) or trailing separator. */
export function sameDir(a: string, b: string): boolean {
  const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  return norm(a) === norm(b)
}

/**
 * The pane status a turn hook implies, or `undefined` to leave it alone.
 *
 * The status used to change only when the user pressed Enter in the pane, so
 * a session working on a request typed in by `ade-msg` stayed "Disponibile"
 * for its whole turn, in the sidebar and in `ade-msg list`. Where the CLI has
 * turn hooks they are the truth both ways. An idle written before the pane was
 * last set working is the previous turn's and does not end this one; a
 * permission question, an error or a pane still opening is not overridden.
 */
export function statusFromActivity(
  status: string,
  activity: Activity | undefined,
  workingSince: number | undefined,
): "working" | "idle" | undefined {
  if (!activity) return undefined
  if (status !== "idle" && status !== "working") return undefined
  if (activity.state === "busy") return status === "working" ? undefined : "working"
  if (status !== "working") return undefined
  return workingSince === undefined || activity.at >= workingSince ? "idle" : undefined
}

/** A CLI without turn hooks counts as free once it has printed nothing for this long. */
export const QUIET_FREE_MS = 4000
/** A "busy" older than this, from a session silent for a minute, is a Stop hook that never ran. */
export const STALE_BUSY_MS = 30 * 60_000

/**
 * Whether text can be typed into a session without interrupting it.
 *
 * Messages between sessions travel in the background: whatever is typed into
 * a session in the middle of a turn is read as the user speaking, pulls the
 * agent off its task and costs a turn. So everything waits for the turn to
 * end. With turn hooks the agent says so itself; without them (codex, agy) a
 * working TUI keeps repainting its spinner, and a few quiet seconds are the
 * end of the turn. A standing permission prompt would take the Enter as its
 * answer, so it is never free.
 */
export function isFree(
  target: { hooked: boolean; permissionPending: boolean; activity?: Activity; lastOutputAt?: number },
  now: number,
): boolean {
  if (target.permissionPending) return false
  const quietFor = target.lastOutputAt === undefined ? Infinity : now - target.lastOutputAt
  if (target.hooked) {
    if (target.activity?.state !== "busy") return true
    return now - target.activity.at > STALE_BUSY_MS && quietFor > 60_000
  }
  return quietFor >= QUIET_FREE_MS
}

/**
 * The activity a hook wrote, if it is about this pane's conversation.
 *
 * A nested agent inherits the spawn's environment and its hook writes to the
 * same file; its turns are not the pane's. When the pane's conversation id is
 * known, only that conversation's turns count.
 */
export function parseActivity(text: string | null | undefined, sessionId?: string): Activity | undefined {
  if (!text) return undefined
  try {
    const raw = JSON.parse(text.replace(/^\ufeff/, "")) as Record<string, unknown>
    if ((raw.state !== "busy" && raw.state !== "idle") || typeof raw.at !== "number") return undefined
    if (sessionId && typeof raw.sessionId === "string" && raw.sessionId !== sessionId) return undefined
    return { state: raw.state, at: raw.at, ...(typeof raw.cwd === "string" && raw.cwd.trim() ? { cwd: raw.cwd } : {}) }
  } catch {
    return undefined
  }
}

/** How long a freshly spawned session has to come up before "not running" means closed. */
export const SPAWN_GRACE_MS = 30_000

export function requestState(
  request: OpenRequest,
  target: { running: boolean; permissionPending: boolean; activity?: Activity },
  now: number,
): RequestState {
  if (!target.running) return now - request.at < SPAWN_GRACE_MS ? "in avvio" : "sessione chiusa"
  if (target.permissionPending) return "attende un permesso"
  // Its turn ended after the request reached it, and no reply came: it answered somewhere else, or forgot.
  const reached = request.deliveredAt ?? request.at
  if (target.activity?.state === "idle" && target.activity.at > reached && !request.update) return "inattiva senza risposta"
  return "in corso"
}

/** After an agent's turn ends without a reply, how long before it is reminded. */
export const IDLE_NUDGE_MS = 20_000
/** How long a typed request may go without starting a turn before Enter is sent again. */
export const RERING_AFTER_MS = 20_000
/** The same for a spawn, whose request is typed only once the new session has settled. */
export const RERING_SPAWN_AFTER_MS = 60_000

/**
 * Whether to press Enter again for a request that never started a turn.
 *
 * The one way a typed line is lost is to stay in the input box: a TUI took the
 * text and its Enter for a paste. With turn hooks that is visible — the line
 * went in and no turn began — and a second Enter is the fix. Only with hooks:
 * without them nothing distinguishes a stuck line from a slow start, and an
 * Enter at the wrong moment answers whatever the agent asks next. Once.
 */
export function shouldRering(
  request: OpenRequest,
  target: { running: boolean; permissionPending: boolean; activity?: Activity; hooked: boolean },
  now: number,
): boolean {
  if (!target.hooked || !target.running || target.permissionPending || (request.rings ?? 0) >= 1) return false
  const since = request.deliveredAt ?? request.at
  const wait = request.deliveredAt !== undefined ? RERING_AFTER_MS : RERING_SPAWN_AFTER_MS
  if (now - since < wait) return false
  // Still in a turn that began before: the line is queued behind it, not stuck.
  if (target.activity?.state === "busy") return false
  return !target.activity || target.activity.at < since
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
  target: {
    running: boolean
    permissionPending: boolean
    lastOutputAt?: number
    activity?: Activity
    /**
     * The target has requests of its own still open. It is quiet because it
     * is waiting on them, the way an orchestrator should, and a reminder
     * would only cost it a turn.
     */
    waitingOnOthers?: boolean
  },
  now: number,
): boolean {
  if (!target.running || target.permissionPending) return false
  if (target.waitingOnOthers) return false
  // A session that said it is blocked is waiting on its caller, not forgetting to answer.
  if (request.update) return false
  if ((request.nudges ?? 0) >= MAX_NUDGES) return false
  if (request.nudgedAt !== undefined && now - request.nudgedAt < NUDGE_GAP_MS) return false
  // With turn hooks the agent's own word decides: working is never nudged, and a turn that ended is.
  if (target.activity?.state === "busy") return false
  const reached = request.deliveredAt ?? request.at
  if (target.activity?.state === "idle" && target.activity.at > reached) return now - target.activity.at >= IDLE_NUDGE_MS
  if (now - request.at < NUDGE_AFTER_MS) return false
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
    request.update && stateOf(request) === "in corso" ? `${request.update.state}: ${briefOf(request.update.text, 40)}` : stateOf(request),
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
  /* The full help is ~800 tokens; `list` is called often and needs none of it. */
  return `${out.join("\n")}\n\naltri comandi: ade-msg help\n`
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
  "  ade-msg update <id> bloccata|decisione \"<motivo>\"  non è una risposta: sveglia chi aspetta, la richiesta resta aperta\n" +
  "  ade-msg wait   <id> [<id>...] [--any]     aspetta le risposte (tutte, o la prima con --any)\n" +
  "  ade-msg status                          richieste in corso\n" +
  "  ade-msg cancel <id>                     annulla una tua richiesta\n" +
  "  ade-msg close  <sessione> [--force]     chiude una sessione avviata da te con spawn e le sue figlie;\n" +
  "                                          rifiuta se una worktree ha lavoro non integrato, salvo --force\n" +
  "  ade-msg relaunch <sessione> [--model <id>] [--fresh]\n" +
  "                                          riavvia una sessione avviata da te, stesso pane e worktree:\n" +
  "                                          riprende la sua conversazione (o da zero con --fresh)\n" +
  "  ade-msg memory add decisione|fatto|trappola|todo \"<testo>\"\n" +
  "                                          aggiunge una voce a .ade/memory.md, la memoria condivisa del progetto\n" +
  "  ade-msg memory show                     stampa la memoria condivisa\n" +
  "  ade-msg kv set <chiave> \"<valore>\" | get <chiave> | del <chiave> | list [<prefisso>]\n" +
  "                                          stato condiviso tra le sessioni del progetto\n" +
  "  ade-msg kv lock <chiave> [--ttl <sec>] [\"<nota>\"] | unlock <chiave> [--force]\n" +
  "                                          lock con scadenza (predefinita 600s): chi lo tiene lo rilascia\n" +
  "  ade-msg stats                           token per sessione e quota letta dalla cache\n" +
  "  ade-msg who-owns <file>                chi possiede il file secondo la bacheca del team (TEAM.md)\n" +
  "  ade-msg agents | whoami\n" +
  "opzioni:\n" +
  "  --no-wait        ask/spawn: stampa subito l'id, poi usa wait (per lanciare in parallelo)\n" +
  "  --name <nome>    spawn: nome della sessione, usabile poi come destinatario\n" +
  "  --worktree       spawn: lavora in una git worktree sul branch ade/<nome>, accanto al progetto\n" +
  "  --model <id>     spawn: modello (claude, codex, agy)\n" +
  "  --fork           spawn: parte dalla tua conversazione e ne riusa la cache (claude, codex;\n" +
  "                   stesso agente e modello, non con --worktree)\n" +
  "  --close          spawn: chiude la sessione dopo la risposta, se non ha lavoro da integrare\n" +
  "                   (di norma resta aperta: serve per i seguiti)\n" +
  "  --file <perc>    ask/spawn/send/reply: il testo è il contenuto del file\n" +
  "  --timeout <sec>  ask/spawn/wait: quanto aspettare (predefinito 110)\n" +
  "<sessione> = numero, id, titolo o nome dell'agente; progetto/nome cerca solo in quel progetto,\n" +
  "  un nome da solo preferisce le sessioni del tuo progetto.\n"
