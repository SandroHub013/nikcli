/**
 * Who is waiting for a design choice: `ade-msg design proponi --attendi` and
 * `ade-msg design attendi`.
 *
 * Each wait is a request id, the same channel `ask` and `wait` use: when the
 * user chooses, ADE writes the line to `results/<id>.txt`, and the script
 * claims it by renaming it (`mailbox.rs`). The waits are kept in
 * localStorage like the answers' outbox, so a reload in the middle neither
 * forgets a script still waiting nor types an answer it already printed.
 *
 * The rule for "read or not": an answer written for a waiter holds the line
 * ADE would type until the waiter is settled. After {@link CLAIM_MS} ADE takes the file back
 * (`mailbox_result_reclaim`): gone means the script took it, and the answer
 * counts as delivered, never typed; still there means nobody was waiting any
 * more (the script's own timeout, or the agent's shell killing it), and the
 * line is typed as it always was. A script that comes back after that finds
 * the answer kept as `<id>.closed` and prints it all the same.
 *
 * Plain `.ts`, so the rule is tested without a window.
 */

export interface DesignWaiter {
  /** The request id the script waits on. */
  readonly id: string
  /** The register the proposal is in. */
  readonly path: string
  readonly k: string
  /** The pane that waits. */
  readonly from: string
  /** The proposal's folder, for the «altro giro» line. */
  readonly folder: string
  /** When the script stops waiting, in ms: past it, an answer is typed rather than written. */
  readonly until: number
  /** The answer written for it, by its time in the register. */
  readonly answeredAt?: string
  readonly writtenAt?: number
}

export const WAITERS_KEY = "ade.design.waiters"

/** How long a written answer waits for its script to take it before it is typed instead. */
export const CLAIM_MS = 15_000

/**
 * How long a written answer may hold its line while ADE cannot tell whether the script took it: past it the waiter
 * is given up and the line typed. Every pass whose check failed proves nothing and asks again, and a check that
 * fails every time (an I/O error that repeats) would otherwise hold the user's choice for a day; a line typed twice
 * is better than a choice lost (review B8). Several claim windows, so a check that fails once or twice still settles.
 */
export const HOLD_MS = 3 * 60 * 1000

/** Past its timeout a script may still be reading its receipt: this much longer counts as waiting. */
export const WAIT_GRACE_MS = 5_000

/** Kept no longer than this, whatever happened: a waiter is never a leftover for good. */
const KEPT_MS = 24 * 60 * 60 * 1000

export function parseWaiters(raw: string | null): DesignWaiter[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter(
      (item): item is DesignWaiter =>
        Boolean(item) &&
        typeof item.id === "string" &&
        typeof item.path === "string" &&
        typeof item.k === "string" &&
        typeof item.from === "string" &&
        typeof item.folder === "string" &&
        typeof item.until === "number",
    )
  } catch {
    return []
  }
}

/** The waiter for a script that waits for `timeoutSeconds` from `now`. */
export function waiterFor(
  request: Pick<DesignWaiter, "id" | "path" | "k" | "from" | "folder">,
  timeoutSeconds: number,
  now: number,
): DesignWaiter {
  return { ...request, until: now + timeoutSeconds * 1000 + WAIT_GRACE_MS }
}

export function addWaiter(list: readonly DesignWaiter[], waiter: DesignWaiter): DesignWaiter[] {
  return [...list.filter((item) => item.id !== waiter.id), waiter]
}

/** The scripts still waiting for proposal `k` of register `path`, with nothing written for them yet. */
export function waitingFor(list: readonly DesignWaiter[], path: string, k: string, now: number): DesignWaiter[] {
  return list.filter((item) => item.path === path && item.k === k && item.writtenAt === undefined && now <= item.until)
}

export function markWritten(
  list: readonly DesignWaiter[],
  ids: readonly string[],
  answeredAt: string,
  now: number,
): DesignWaiter[] {
  return list.map((item) => (ids.includes(item.id) ? { ...item, answeredAt, writtenAt: now } : item))
}

export function dropWaiters(list: readonly DesignWaiter[], ids: readonly string[]): DesignWaiter[] {
  return list.filter((item) => !ids.includes(item.id))
}

/**
 * Whether the line for this answer waits, because a script may be taking it.
 *
 * Until the waiter is settled, not until its window ends: the check that
 * settles it is asynchronous, and a delivery pass that ran at the end of the
 * window, beside it, typed the line the script had already printed (seen
 * live in ADE Test). Only `settle` lets it go, by dropping the waiter; a
 * waiter that cannot be settled is given up after {@link HOLD_MS} (`givenUp`).
 */
export function holdsDelivery(
  list: readonly DesignWaiter[],
  answer: { readonly path: string; readonly k: string; readonly answeredAt: string },
  now: number,
): boolean {
  return list.some(
    (item) =>
      item.path === answer.path &&
      item.k === answer.k &&
      item.answeredAt === answer.answeredAt &&
      item.writtenAt !== undefined &&
      !givenUp(item, now),
  )
}

/** A written waiter whose script ADE could not check for {@link HOLD_MS}: dropped, and its line typed. */
export function givenUp(item: DesignWaiter, now: number): boolean {
  return item.writtenAt !== undefined && now - item.writtenAt >= HOLD_MS
}

/** The written waiters whose script has had its time: ADE asks whether the answer was taken. */
export function dueWaiters(list: readonly DesignWaiter[], now: number): DesignWaiter[] {
  return list.filter((item) => item.writtenAt !== undefined && now >= item.writtenAt + CLAIM_MS)
}

/** Without the waits that can no longer matter: unanswered past their script's end, and anything a day old. */
export function pruneWaiters(list: readonly DesignWaiter[], now: number): DesignWaiter[] {
  return list.filter((item) => {
    if (item.writtenAt !== undefined) return now - item.writtenAt < KEPT_MS
    return now <= item.until
  })
}
