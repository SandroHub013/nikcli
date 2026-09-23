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
