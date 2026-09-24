/**
 * When a Claude session that has stopped may be suspended (P1-C6, D79 = B).
 *
 * A Claude session at rest keeps about 800 MB between `claude.exe` and its MCP
 * servers. Suspending closes those processes and keeps the pane and its text;
 * resuming reopens the same conversation by its id. Every condition below
 * protects that promise: the conversation must be on disk to be reopened, and
 * nothing may be under way — a turn, a prompt, a request either way, a message
 * waiting to be typed, a line the user has begun — because the processes that
 * would carry it are about to go.
 *
 * Pure, so the button, the palette and the check repeated just before the kill
 * ask the same question and get the same answer.
 */

import type { MessageKey } from "../i18n"

export type SuspendBlock =
  | "notClaude"
  | "suspended"
  | "notRunning"
  | "noConversation"
  | "working"
  | "permission"
  | "requestTo"
  | "requestFrom"
  | "held"
  | "typing"

export type SuspendCheck = { ok: true } | { ok: false; reason: SuspendBlock }

export interface SuspendPane {
  id: string
  agent?: string
  status: string
  resumeId?: string
  suspended?: true
}

export interface SuspendContext {
  /** A live process behind the pane (`running.has`). */
  running: boolean
  /** The agent never wrote the conversation `resumeId` names: resuming would open a new one. */
  conversationMissing: boolean
  /** A permission prompt is open in the pane. */
  permission: boolean
  openRequests: Iterable<{ from: string; to: string }>
  heldLines: Iterable<{ paneId: string }>
  /** The user has begun a line in the pane (`records.typed`). */
  typing: boolean
}

/** Whether the command is offered at all: only Claude sessions are suspended. */
export function offersSuspend(pane: { agent?: string } | undefined): boolean {
  return pane?.agent === "claude-code"
}

export function canSuspend(pane: SuspendPane, ctx: SuspendContext): SuspendCheck {
  const no = (reason: SuspendBlock): SuspendCheck => ({ ok: false, reason })
  if (!offersSuspend(pane)) return no("notClaude")
  if (pane.suspended) return no("suspended")
  if (!ctx.running) return no("notRunning")
  if (!(pane.resumeId ?? "").trim() || ctx.conversationMissing) return no("noConversation")
  if (pane.status !== "idle") return no("working")
  if (ctx.permission) return no("permission")
  const requests = [...ctx.openRequests]
  if (requests.some((request) => request.to === pane.id)) return no("requestTo")
  if (requests.some((request) => request.from === pane.id)) return no("requestFrom")
  for (const line of ctx.heldLines) if (line.paneId === pane.id) return no("held")
  if (ctx.typing) return no("typing")
  return { ok: true }
}

/**
 * Closes a suspended session's process and everything it started — the MCP
 * servers are its children — and waits for the kill to have run, so the pane
 * says "Sospesa" when the processes are gone. False when the kill failed.
 */
export async function closeSuspendedTree(session: { kill: (options?: { tree?: boolean }) => void | Promise<boolean> } | undefined): Promise<boolean> {
  if (!session) return true
  try {
    return (await session.kill({ tree: true })) !== false
  } catch {
    return false
  }
}

type Killable = { kill: (options?: { tree?: boolean }) => void | Promise<boolean> }

/**
 * Takes the session out of `running` and closes its tree. Out before the kill,
 * as a relaunch does, so nothing reads the exit as the session ending. A kill
 * that fails puts it back: a process perhaps still alive stays followed, and
 * "Riprendi" never opens a second one on the same conversation.
 */
export async function stopForSuspend<S extends Killable>(paneId: string, running: Map<string, S>, changed: () => void): Promise<boolean> {
  const session = running.get(paneId)
  running.delete(paneId)
  changed()
  const closed = await closeSuspendedTree(session)
  if (!closed && session) {
    running.set(paneId, session)
    changed()
  }
  return closed
}

/** The header's "Sospendi": not on a pane already suspended, where "Riprendi" stands. */
export function showsSuspendButton(check: SuspendCheck | undefined): check is SuspendCheck {
  return check !== undefined && (check.ok || check.reason !== "suspended")
}

/** The words shown for each reason, as the command's tooltip. */
export const SUSPEND_REASON: Readonly<Record<SuspendBlock, MessageKey>> = {
  notClaude: "suspend.why.notClaude",
  suspended: "suspend.why.suspended",
  notRunning: "suspend.why.notRunning",
  noConversation: "suspend.why.noConversation",
  working: "suspend.why.working",
  permission: "suspend.why.permission",
  requestTo: "suspend.why.requestTo",
  requestFrom: "suspend.why.requestFrom",
  held: "suspend.why.held",
  typing: "suspend.why.typing",
}

/*
 * Mail for a suspended session (point 3). Nothing wakes it: a `send` or an
 * `ask` waits in a queue that survives ADE's restart and is delivered, in the
 * order it came, once the user resumes the session; `restart` is refused. The
 * check comes before the route is chosen: a suspended Claude session has no
 * pipe of its own, and `SendMessage` to it fails with ENOINBOX.
 */

export type SuspendedDelivery = { queue: true; receipt: string } | { queue: false; refusal: string }

/**
 * What a message to a suspended session becomes; undefined for the kinds that
 * take their usual way (an interrupt or a close have nothing to queue).
 *
 * The receipt starts with "ok": `ade-msg` exits 1 on any other, and a queued
 * message is not a refusal.
 */
export function suspendedDelivery(kind: string, title: string): SuspendedDelivery | undefined {
  if (kind === "send" || kind === "ask") {
    return { queue: true, receipt: `ok: in coda: la sessione "${title}" è sospesa; la riceve quando l'utente la riprende` }
  }
  if (kind === "relaunch") return { queue: false, refusal: `errore: la sessione "${title}" è sospesa: la riprende l'utente` }
  return undefined
}

/** A line waiting for a session, as `heldLines` keeps it. */
export interface QueuedLine {
  paneId: string
  text: string
  full?: string
  inbox?: { id: string; kind: "ask" | "send"; from: string }
  /** Queued while the session was suspended: its request counts as delivered only once it is typed. */
  suspended?: true
}

/** The lines kept for suspended sessions, as they are saved. */
export function suspendedMailToSave(
  lines: readonly (Omit<QueuedLine, "inbox"> & { inbox?: { id: string; kind: string; from: string } })[],
  isSuspended: (paneId: string) => boolean,
): QueuedLine[] {
  const saved: QueuedLine[] = []
  for (const { paneId, text, full, inbox, suspended } of lines) {
    if (!suspended || !isSuspended(paneId)) continue
    // Only mail is queued for a suspended session: `send` and `ask`.
    if (inbox && inbox.kind !== "ask" && inbox.kind !== "send") continue
    saved.push({
      paneId,
      text,
      ...(full !== undefined ? { full } : {}),
      ...(inbox ? { inbox: { id: inbox.id, kind: inbox.kind as "ask" | "send", from: inbox.from } } : {}),
      suspended: true,
    })
  }
  return saved
}

/** The saved queue read back; anything malformed is dropped, the order is kept. */
export function parseSuspendedMail(text: string | null | undefined): QueuedLine[] {
  if (!text) return []
  try {
    const raw: unknown = JSON.parse(text)
    if (!Array.isArray(raw)) return []
    const lines: QueuedLine[] = []
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue
      const { paneId, text: line, full, inbox } = entry as Record<string, unknown>
      if (typeof paneId !== "string" || !paneId || typeof line !== "string") continue
      let meta: QueuedLine["inbox"]
      if (inbox !== undefined) {
        const { id, kind, from } = (inbox ?? {}) as Record<string, unknown>
        if (typeof id !== "string" || (kind !== "ask" && kind !== "send") || typeof from !== "string") continue
        meta = { id, kind, from }
      }
      lines.push({ paneId, text: line, ...(typeof full === "string" ? { full } : {}), ...(meta ? { inbox: meta } : {}), suspended: true })
    }
    return lines
  } catch {
    return []
  }
}
