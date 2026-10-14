/*
 * The messages held for a busy session, kept across a restart of ADE.
 *
 * `ade-msg send` and `ask` are taken out of the outbox the moment ADE reads them, and a message for a session that is
 * not free is answered «ok: in coda» and kept in memory until the turn ends. The sender stops listening at that
 * receipt, so a restart in between lost the message and told nobody (2026-10-14: the 17:43 note to «Sol 6.1»).
 *
 * Saved here, in `localStorage` like the open requests; read back once the panes are restored, and delivered by the
 * ordinary pass. A message that is too old is not delivered late: its sender is told it was not (`parseQueue`).
 */

import { isRequestId, type Message } from "./mailbox"

/** A message taken from the outbox and not delivered yet. */
export interface QueuedMessage {
  id: string
  message: Message
  /** When ADE took it from the outbox. */
  at: number
}

/** Past this a held message is not typed into a session any more: it would arrive as news of another day. */
export const QUEUE_MAX_AGE_MS = 12 * 60 * 60_000

/** The kinds that wait for a free session: the ones answered «in coda». */
function isMail(message: Message): message is Message & { kind: "send" | "ask"; to: string } {
  return message.kind === "send" || message.kind === "ask"
}

/**
 * The queue as it is written down.
 *
 * Without the token: it proved the sender to the process that received it, and the process that reads this back
 * has other tokens. `from` was verified before the message was queued and is kept as it stood.
 */
export function queueToSave(queue: readonly QueuedMessage[]): string {
  const kept = queue
    .filter((item) => isRequestId(item.id) && isMail(item.message))
    .map(({ id, message, at }) => {
      const { token: _token, ...rest } = message
      return { id, at, message: rest }
    })
  return JSON.stringify(kept)
}

/** The saved queue read back, in order, split by age; anything malformed is dropped on its own. */
export function parseQueue(
  text: string | null | undefined,
  now: number,
): { live: QueuedMessage[]; expired: QueuedMessage[] } {
  const live: QueuedMessage[] = []
  const expired: QueuedMessage[] = []
  if (!text) return { live, expired }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { live, expired }
  }
  if (!Array.isArray(raw)) return { live, expired }
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const { id, at, message } = entry as Record<string, unknown>
    if (typeof id !== "string" || !isRequestId(id) || typeof at !== "number" || !Number.isFinite(at)) continue
    if (!message || typeof message !== "object") continue
    const body = message as Record<string, unknown>
    if (body.kind !== "send" && body.kind !== "ask") continue
    if (typeof body.from !== "string" || typeof body.to !== "string" || !body.to || typeof body.text !== "string") continue
    const item: QueuedMessage = { id, at, message: body as unknown as Message }
    ;(now - at > QUEUE_MAX_AGE_MS ? expired : live).push(item)
  }
  return { live, expired }
}
