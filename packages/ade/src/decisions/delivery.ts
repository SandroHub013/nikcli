/**
 * How an answer given in ADE reaches the session that will act on it.
 *
 * The register is the record; the message is the nudge. When the user answers
 * in the panel, ADE appends the `risposta` event and then types a `risolta`
 * line into the session the user chose for the project, so it does not have to
 * poll the register to find out. If none is chosen, or it is not running, or
 * it is in the middle of a turn, the line waits in an outbox and goes as soon
 * as it can.
 *
 * The outbox holds only answers given in this ADE, kept in localStorage so a
 * restart does not lose one on its way. An answer written into the register
 * by somebody else — a session from the shell, an import — is not sent back to
 * anybody: whoever wrote it already knows.
 *
 * Plain `.ts`, so the choice of recipient and the outbox rules are testable.
 */

import type { Decision } from "./state"
import { resolvedMessage } from "./state"

/** A session that could receive the line, as `mailPanes` describes it. */
export interface DeliveryCandidate {
  readonly id: string
  readonly title: string
  readonly project?: string
  readonly running: boolean
}

/** The session the user chose to receive a project's answers, as it was titled when chosen. */
export interface RecipientChoice {
  readonly id: string
  readonly title: string
}

/** Per register path: each project has its own recipient, or none. */
export const RECIPIENT_KEY = "ade.decisions.recipient"

export function parseRecipients(raw: string | null): Record<string, RecipientChoice> {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const kept: Record<string, RecipientChoice> = {}
    for (const [path, choice] of Object.entries(value as Record<string, unknown>)) {
      const item = choice as Partial<RecipientChoice> | null
      if (item && typeof item.id === "string" && typeof item.title === "string") kept[path] = { id: item.id, title: item.title }
    }
    return kept
  } catch {
    return {}
  }
}

/** Sets, or with `undefined` clears, the recipient for one register. */
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
  /** Chosen and running: answers go to it as soon as it is free. */
  | { readonly state: "pronta"; readonly id: string; readonly title: string }
  /** Nobody chosen: answers wait in the outbox. */
  | { readonly state: "non scelta" }
  /** Chosen, but closed or not running: answers wait until it runs again. */
  | { readonly state: "non attiva"; readonly id: string; readonly title: string }

/**
 * Who gets the answers: only the session the user chose, by pane id.
 *
 * No title is special. Which session coordinates is the user's call, and a
 * guess by name would type an answer into a session that never asked for it.
 * Pane ids survive a restart, so the choice holds across one.
 */
export function resolveRecipient(candidates: readonly DeliveryCandidate[], choice: RecipientChoice | undefined): RecipientStatus {
  if (!choice) return { state: "non scelta" }
  const pane = candidates.find((candidate) => candidate.id === choice.id)
  if (pane?.running) return { state: "pronta", id: pane.id, title: pane.title }
  return { state: "non attiva", id: choice.id, title: pane?.title ?? choice.title }
}

/** The line typed into the recipient's terminal. */
export function deliveryLine(decision: Decision): string {
  return `[Decisione da utente] ${resolvedMessage(decision)}`
}

export interface OutboxItem {
  /** The register the answer is in; one ADE can have several projects open. */
  readonly path: string
  readonly k: string
  /** The answer's own timestamp: a changed answer is a different item. */
  readonly answeredAt: string
  readonly queuedAt: number
  readonly deliveredTo?: string
  readonly deliveredAt?: number
}

export const OUTBOX_KEY = "ade.decisions.outbox"

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

/** Adds an answer to send, replacing whatever was queued for the same decision. */
export function enqueue(outbox: readonly OutboxItem[], item: Omit<OutboxItem, "deliveredTo" | "deliveredAt">): OutboxItem[] {
  return [...outbox.filter((entry) => !(entry.path === item.path && entry.k === item.k)), { ...item }]
}

export function markDelivered(outbox: readonly OutboxItem[], item: OutboxItem, to: string, at: number): OutboxItem[] {
  return outbox.map((entry) => (entry === item ? { ...entry, deliveredTo: to, deliveredAt: at } : entry))
}

/**
 * The items still worth keeping for one register: an answer that is still the
 * standing one and not yet closed. Once a session closes a decision, or the user
 * changes the answer, the old item has nothing left to say.
 */
export function pruneOutbox(outbox: readonly OutboxItem[], path: string, decisions: readonly Decision[]): OutboxItem[] {
  const byKey = new Map(decisions.map((decision) => [decision.k, decision]))
  return outbox.filter((item) => {
    if (item.path !== path) return true
    const decision = byKey.get(item.k)
    return decision?.status === "risposta" && decision.answer?.at === item.answeredAt
  })
}

/** The items for `path` that still have to go out, oldest first. */
export function pendingFor(outbox: readonly OutboxItem[], path: string): OutboxItem[] {
  return outbox.filter((item) => item.path === path && item.deliveredAt === undefined).sort((a, b) => a.queuedAt - b.queuedAt)
}

export type DeliveryState =
  | { readonly state: "consegnata"; readonly to: string; readonly at: number }
  | { readonly state: "in coda" }
  | { readonly state: "fuori da ADE" }

/** What to say under an answer that is waiting to be carried out. */
export function deliveryState(outbox: readonly OutboxItem[], path: string, decision: Decision): DeliveryState {
  const item = outbox.find((entry) => entry.path === path && entry.k === decision.k && entry.answeredAt === decision.answer?.at)
  if (!item) return { state: "fuori da ADE" }
  if (item.deliveredAt !== undefined && item.deliveredTo) return { state: "consegnata", to: item.deliveredTo, at: item.deliveredAt }
  return { state: "in coda" }
}
