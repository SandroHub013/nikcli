import type { DesignProposal } from "./state"
import { resolvedMessage } from "./state"
import { t } from "../i18n"

export interface DeliveryCandidate {
  readonly id: string
  readonly title: string
  readonly project?: string
  readonly running: boolean
}

export interface RecipientChoice {
  readonly id: string
  readonly title: string
}

export const RECIPIENT_KEY = "ade.design.recipient"

export function parseRecipients(raw: string | null): Record<string, RecipientChoice> {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const kept: Record<string, RecipientChoice> = {}
    for (const [path, choice] of Object.entries(value as Record<string, unknown>)) {
      const item = choice as Partial<RecipientChoice> | null
      if (item && typeof item.id === "string" && typeof item.title === "string") {
        kept[path] = { id: item.id, title: item.title }
      }
    }
    return kept
  } catch {
    return {}
  }
}

export function chooseRecipient(
  all: Readonly<Record<string, RecipientChoice>>,
  path: string,
  choice: RecipientChoice | undefined,
): Record<string, RecipientChoice> {
  const next = { ...all }
  if (choice) next[path] = { id: choice.id, title: choice.title }
  else delete next[path]
  return next
}

export type RecipientStatus =
  | { readonly state: "pronta"; readonly id: string; readonly title: string }
  | { readonly state: "non scelta" }
  | { readonly state: "non attiva"; readonly id: string; readonly title: string }

export interface RecipientOption {
  readonly value: string
  readonly label: string
  readonly selected: boolean
}

export function recipientOptions(
  sessions: readonly DeliveryCandidate[],
  recipient: RecipientStatus,
  pending?: string,
): RecipientOption[] {
  const shown = pending ?? (recipient.state === "non scelta" ? "" : recipient.id)
  const options: RecipientOption[] = [{ value: "", label: t("design.recipient.nobody"), selected: shown === "" }]
  for (const pane of sessions) {
    const label = `${pane.title}${pane.project ? ` · ${pane.project}` : ""}${pane.running ? "" : ` ${t("design.recipient.stopped")}`}`
    options.push({ value: pane.id, label, selected: pane.id === shown })
  }
  if (recipient.state !== "non scelta" && !sessions.some((pane) => pane.id === recipient.id)) {
    options.push({ value: recipient.id, label: `${recipient.title} ${t("design.recipient.closed")}`, selected: recipient.id === shown })
  }
  return options
}

export function recipientChange(currentId: string | undefined, nextId: string | undefined, queued: number): "nessuna" | "applica" | "conferma" {
  if ((currentId ?? "") === (nextId ?? "")) return "nessuna"
  if (!nextId || queued === 0) return "applica"
  return "conferma"
}

export function resolveRecipient(candidates: readonly DeliveryCandidate[], choice: RecipientChoice | undefined): RecipientStatus {
  if (!choice) return { state: "non scelta" }
  const pane = candidates.find((candidate) => candidate.id === choice.id)
  if (pane?.running) return { state: "pronta", id: pane.id, title: pane.title }
  return { state: "non attiva", id: choice.id, title: pane?.title ?? choice.title }
}

export function deliveryLine(proposal: DesignProposal): string {
  return `[Design da utente] ${resolvedMessage(proposal)}`
}

export interface OutboxItem {
  readonly path: string
  readonly k: string
  readonly answeredAt: string
  readonly queuedAt: number
  readonly deliveredTo?: string
  readonly deliveredAt?: number
}

export const OUTBOX_KEY = "ade.design.outbox"

export function parseOutbox(raw: string | null): OutboxItem[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter(
      (item): item is OutboxItem =>
        Boolean(item) &&
        typeof item.path === "string" &&
        typeof item.k === "string" &&
        typeof item.answeredAt === "string" &&
        typeof item.queuedAt === "number",
    )
  } catch {
    return []
  }
}

export function enqueue(outbox: readonly OutboxItem[], item: Omit<OutboxItem, "deliveredTo" | "deliveredAt">): OutboxItem[] {
  return [...outbox.filter((entry) => !(entry.path === item.path && entry.k === item.k)), { ...item }]
}

export function markDelivered(outbox: readonly OutboxItem[], item: OutboxItem, to: string, at: number): OutboxItem[] {
  return outbox.map((entry) => (entry === item ? { ...entry, deliveredTo: to, deliveredAt: at } : entry))
}

export function pruneOutbox(outbox: readonly OutboxItem[], path: string, proposals: readonly DesignProposal[]): OutboxItem[] {
  const byKey = new Map(proposals.map((proposal) => [proposal.k, proposal]))
  return outbox.filter((item) => {
    if (item.path !== path) return true
    const proposal = byKey.get(item.k)
    return proposal?.status === "risposta" && proposal.answer?.at === item.answeredAt
  })
}

export function pendingFor(outbox: readonly OutboxItem[], path: string): OutboxItem[] {
  return outbox.filter((item) => item.path === path && item.deliveredAt === undefined).sort((a, b) => a.queuedAt - b.queuedAt)
}

export type DeliveryState =
  | { readonly state: "consegnata"; readonly to: string; readonly at: number }
  | { readonly state: "in coda" }
  | { readonly state: "fuori da ADE" }

export function deliveryState(outbox: readonly OutboxItem[], path: string, proposal: DesignProposal): DeliveryState {
  const item = outbox.find((entry) => entry.path === path && entry.k === proposal.k && entry.answeredAt === proposal.answer?.at)
  if (!item) return { state: "fuori da ADE" }
  if (item.deliveredAt !== undefined && item.deliveredTo) return { state: "consegnata", to: item.deliveredTo, at: item.deliveredAt }
  return { state: "in coda" }
}
