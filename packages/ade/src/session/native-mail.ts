/**
 * Mail between two Claude Code sessions goes the way Claude Code already has.
 *
 * The CLI gives every session an inbox of its own (`ListAgents` /
 * `SendMessage`, documented under "cross-session messaging"): a message from
 * one session lands in the other's context between two tool calls, or opens
 * a turn if it was idle, and never touches its input line. That is the whole
 * problem S65 was about, solved by the CLI itself — for one agent out of the
 * catalogue. The other ten, and the shell, keep being typed into, behind the
 * half-written-line guard.
 *
 * Who delivers: the sender. `SendMessage` is a tool only a Claude has, and
 * every claude-code session has it, so when both ends are claude-code ADE
 * types nothing: it books the request as it always did — id, who answers
 * whom, the results file — and hands the sender the exact line to send. A
 * process that would do the sending on ADE's behalf was measured at 0.08 to
 * 0.64 dollars a message and refused (S65, update 3).
 *
 * Nothing in this file talks to the CLI. It decides, from what the workbench
 * already knows plus one documented listing (`claude agents --json`), whether
 * the native way is open — and says why when it is not, because a message
 * that took the other way has to be traceable from ADE.
 */

export const CLAUDE = "claude-code"

/**
 * Arguments that make a session reachable by name.
 *
 * `--name` is how another session addresses it, so the pane's title becomes
 * its name; the CLI keeps the name only if free, and renames to a variant
 * otherwise — which is why nothing here ever assumes the name took, and the
 * listing is asked for the name that did.
 *
 * Deliberately no `crossSessionInbound: accept`. With it, any Claude session
 * of the machine — one that asks for permissions, or one with an injected
 * prompt — could drive an ADE session that skips them. Without it the CLI
 * applies its own rule, permission parity: a message passes when sender and
 * receiver are in the same class (bypass to bypass, which is nearly all of
 * ours, so the team's mail stays native), and is held when a session that asks
 * writes to one that does not. The CLI tells the sender `success:true` even then,
 * and only afterwards that the message was held, so the sender confirms too
 * early: ADE picks the way before (`routeFor`, from the mode bars) and types,
 * with `verifySender`, when the classes differ or one is unknown; and a
 * `delivered <id> no` after a confirmation still makes ADE type it
 * (`lateNo`). The setting would never be written to `~/.claude/settings.json`
 * either way: the user's rules are the user's.
 */
export function nativeLaunchArgs(agentId: string, title: string): string[] {
  if (agentId !== CLAUDE) return []
  return ["--name", nativeName(title)]
}

/** The pane's title as a session name: trimmed, one line, never empty. */
export function nativeName(title: string): string {
  const clean = title
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim()
  return clean || "ade"
}

/** One row of `claude agents --json`, as much of it as the route needs. */
export interface NativeSession {
  sessionId: string
  name: string
}

/**
 * The sessions the CLI lists, from the output of `claude agents --json`.
 *
 * Tolerant on purpose: a row without a session id or a name is a row nobody
 * can be addressed by, and is left out; anything that is not a JSON array
 * means the CLI is not one that lists — an older version, a failure — and the
 * answer is "nobody", which routes everything to typing.
 */
export function parseNativeSessions(output: string): NativeSession[] {
  let raw: unknown
  try {
    raw = JSON.parse(output.replace(/^\ufeff/, ""))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const rows: NativeSession[] = []
  for (const row of raw) {
    if (!row || typeof row !== "object") continue
    const { sessionId, name } = row as Record<string, unknown>
    if (typeof sessionId !== "string" || !sessionId || typeof name !== "string" || !name) continue
    /*
     * `kind`, `status` and `state` are read by nobody, so they are not kept: a
     * field that looks like a guard and is not one misleads the next reader.
     * The review found a month-old `state: "blocked"` row in the live list,
     * and the live test a fresh session with no `status` at all, so none of
     * them can say "alive" without a vocabulary the CLI does not document. A
     * dead row costs one 90 s clock, not a message.
     */
    rows.push({ sessionId, name })
  }
  return rows
}

/** The CLI's two classes of permission: a session that skips the prompts, and one that asks. Mail passes between the same class. */
export type PermissionClass = "bypass" | "prompting"

/**
 * The class a Claude pane is in, from the mode bar at the foot of its screen (`bypass permissions on`, `manual mode on`, ...).
 * The last mention in `text` wins: Shift+Tab repaints the bar, and what came before may still be in the window. Colour codes between
 * the words are ignored. Anything else (`auto mode`, no bar seen) is unknown, and unknown goes to the keyboard.
 */
export function permissionClassIn(text: string): PermissionClass | undefined {
  // A space, not nothing: a cursor move or a carriage return between two cells separates words, it does not erase them.
  const plain = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\r/g, " ")
  let found: { at: number; class: PermissionClass } | undefined
  const patterns: [RegExp, PermissionClass][] = [
    [/bypass\s+permissions\s+on/gi, "bypass"],
    [/(?:manual\s+mode|accept\s+edits|plan\s+mode)\s+on/gi, "prompting"],
  ]
  for (const [pattern, kind] of patterns) {
    for (const match of plain.matchAll(pattern)) {
      if (!found || match.index > found.at) found = { at: match.index, class: kind }
    }
  }
  return found?.class
}

/** How much raw output each pane keeps for reading its mode bar: a few repaints of the bar, escape sequences included. */
const MODE_TAIL = 1200

/**
 * The permission class of each Claude pane, read from the raw pty chunks and not from lines. The mode bar is repainted in a chunk with no
 * newline (`ESC[H`, a carriage return, the bar, `ESC[21;1H`): the line path keeps it pending and then `stripAnsi` erases it, so it
 * never reaches `permissionClassIn`. A short raw tail per pane also catches a bar split between two chunks. The last bar in the tail wins.
 */
export function createModeTracker(limit: number = MODE_TAIL) {
  const tails = new Map<string, string>()
  return {
    /** Adds a raw chunk to the pane's tail and returns the class its last mode bar says, if the tail holds one. */
    push(paneId: string, chunk: string): PermissionClass | undefined {
      const tail = ((tails.get(paneId) ?? "") + chunk).slice(-limit)
      tails.set(paneId, tail)
      return permissionClassIn(tail)
    },
    forget(paneId: string): void {
      tails.delete(paneId)
    },
  }
}

export interface RouteInput {
  /** Which CLI each end runs. */
  senderAgent?: string
  targetAgent?: string
  /** The conversation id ADE started the target under, if it is known. */
  targetSessionId?: string
  /** What the CLI listed, or nothing if the listing could not be had. */
  listed: readonly NativeSession[] | undefined
  /** The sender asked for the keyboard (`ade-msg … --digita`). */
  typedRequested?: boolean
  /**
   * The sender was already told "in coda" for this message. Its `ade-msg`
   * has returned: a handoff written now would be a receipt nobody reads, and
   * the message would be booked and never sent. Once queued for the
   * keyboard, it stays there.
   */
  alreadyQueued?: boolean
  /**
   * The permission class of each end, as ADE read it off the panes' mode bars. The CLI holds a message from a session that asks
   * permission to one that does not, behind a dialog in the target, and still tells the sender `success:true`: so the way is picked
   * here, before, and native only when both ends are known and the same.
   */
  senderClass?: PermissionClass
  targetClass?: PermissionClass
}

export type Route = { via: "nativa"; name: string } | { via: "digitata"; reason: string }

/**
 * Which way a message goes, and why when it is the keyboard.
 *
 * Every "no" here is a fallback, not a failure: a sender that is not a
 * Claude, a target that is not, a target started before it had a name, a CLI
 * that does not list, a session the listing does not show — all of them mean
 * the message is typed, protected, as every message was until now. The reason
 * is kept so ADE can say which way each message went.
 */
export function routeFor(input: RouteInput): Route {
  if (input.typedRequested) return { via: "digitata", reason: "chiesta dal mittente" }
  if (input.alreadyQueued) return { via: "digitata", reason: "già in coda per la digitazione" }
  if (input.senderAgent !== CLAUDE) return { via: "digitata", reason: "il mittente non è una sessione Claude" }
  if (input.targetAgent !== CLAUDE) return { via: "digitata", reason: "il destinatario non è una sessione Claude" }
  if (!input.targetSessionId) return { via: "digitata", reason: "conversazione del destinatario non ancora nota" }
  if (input.listed === undefined)
    return { via: "digitata", reason: "il CLI non elenca le sessioni (claude agents --json)" }
  const row = input.listed.find((session) => session.sessionId === input.targetSessionId)
  if (!row) return { via: "digitata", reason: "destinatario non nell'elenco del CLI" }
  if (!input.senderClass) return { via: "digitata", reason: "la modalità di permesso del mittente non è nota" }
  if (!input.targetClass) return { via: "digitata", reason: "la modalità di permesso del destinatario non è nota" }
  if (input.senderClass !== input.targetClass) {
    const word = (kind: PermissionClass) => (kind === "bypass" ? "bypass" : "chiede")
    return {
      via: "digitata",
      reason: `mittente e destinatario hanno permessi di classe diversa (mittente: ${word(input.senderClass)}, destinatario: ${word(input.targetClass)})`,
    }
  }
  return { via: "nativa", name: row.name }
}

/**
 * The receipt that hands the delivery to the sender.
 *
 * Starts with `ok` so `ade-msg` exits 0, and with the words the scripts look
 * for to return at once instead of waiting: the sender has to send before
 * anyone can answer. The line is the same one ADE would have typed, contract
 * included, so the receiving side replies through `ade-msg` as always.
 */
export const HANDOFF_PREFIX = "ok: consegna tu"

export function formatHandoff(name: string, id: string, line: string): string {
  return (
    `${HANDOFF_PREFIX} — SendMessage alla sessione "${name}" con esattamente questo testo: ${line}\n` +
    `Poi conferma con: ade-msg delivered ${id}. Se SendMessage fallisce o il CLI dice trattenuto o rifiutato: ` +
    `ade-msg delivered ${id} no, e ADE lo digita lei.`
  )
}

/**
 * How long ADE waits for the sender's `ade-msg delivered` before it types
 * the message itself. Long enough for a tool call and its turn; short enough
 * that a caller who forgot does not leave the other session without mail.
 */
export const HANDOFF_ACK_MS = 90_000

export interface Handoff {
  /** Whose mail, and what ADE would have typed. */
  paneId: string
  line: string
  /** The same text with the sender's line breaks, for the inbox copy if the fallback goes there. */
  full?: string
  id: string
  kind: "ask" | "send"
  from: string
  at: number
}

/**
 * Handoffs as saved across a restart, next to the open requests; anything
 * malformed is dropped. Saved because a `send` leaves no other line on disk:
 * the review found that an ADE closed within the 90 s lost the note with
 * nobody told — the sender had its ok, the target never knew. Replayed at
 * start, an old handoff runs into the same clock as a live one and is typed,
 * marked as a possible repeat.
 */
export function parseHandoffs(text: string | null | undefined): Handoff[] {
  if (!text) return []
  try {
    const raw: unknown = JSON.parse(text)
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (entry): entry is Handoff =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as Handoff).paneId === "string" &&
          typeof (entry as Handoff).line === "string" &&
          typeof (entry as Handoff).id === "string" &&
          ((entry as Handoff).kind === "ask" || (entry as Handoff).kind === "send") &&
          typeof (entry as Handoff).from === "string" &&
          typeof (entry as Handoff).at === "number",
      )
      .map(({ paneId, line, full, id, kind, from, at }) => ({
        paneId,
        line,
        ...(typeof full === "string" ? { full } : {}),
        id,
        kind,
        from,
        at,
      }))
  } catch {
    return []
  }
}

/**
 * What to do with a handoff nobody has confirmed yet.
 *
 * `delivered` when the sender said so, `fallback` when it said no or the clock
 * ran out: the message is typed, protected, and the sender is not asked again.
 * A sender that did send and forgot to say so costs the target a repeat, which
 * the typed line says it may be; a sender that never sent costs nothing.
 *
 * The target's turn hook is deliberately not a witness. The first version
 * took "a turn began after the handoff" as delivery, and the live test showed
 * a turn opened by ADE's own reminder confirming a message nobody had sent:
 * the mail was gone and the note said it had arrived. Anything opens a turn —
 * the user, other mail, a nudge — so the only word that counts is the sender's,
 * and the worst it can be wrong by is one repeat.
 */
export function handoffOutcome(
  handoff: Pick<Handoff, "at">,
  seen: { acked?: boolean; failed?: boolean },
  now: number,
): "wait" | "delivered" | "fallback" {
  if (seen.failed) return "fallback"
  if (seen.acked) return "delivered"
  return now - handoff.at >= HANDOFF_ACK_MS ? "fallback" : "wait"
}

/** How long after its own confirmation a sender's `delivered <id> no` still makes ADE type the message. */
export const LATE_NO_MS = 5 * 60_000

/**
 * What a `delivered <id> no` is, once the handoff is closed. After the sender's own confirmation it is still a refusal worth
 * acting on (the CLI answers `success:true` and holds the message afterwards), for a short time; after ADE typed it, it is nothing.
 */
export function lateNo(
  closed: { how: "confermata" | "digitata"; at: number; by?: "mittente" } | undefined,
  now: number,
): "retype" | "late" | "typed" | "unknown" {
  if (!closed) return "unknown"
  if (closed.how === "digitata") return "typed"
  return now - closed.at <= LATE_NO_MS ? "retype" : "late"
}

/** The typed line, when the native way was tried first. */
export function formatFallbackLine(line: string, reason: string): string {
  return `${line} [ripiego: ${reason}; se l'hai già ricevuto via SendMessage, ignora questo doppione]`
}

export function isHandoff(receipt: string): boolean {
  return receipt.startsWith(HANDOFF_PREFIX)
}
