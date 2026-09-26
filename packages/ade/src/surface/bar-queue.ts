/**
 * The words of the two queue buttons in the bar, Decisioni and Design (DS-polish,
 * closures 3 and 4): one grammar for both — the name, the count for you in a
 * pill, then what is queued and what was discarded — and a name for the screen
 * reader that says the same words in the same order.
 *
 * Kept out of the component so the rule «the aria-label is the text you read»
 * is tested without a DOM.
 */
import { t } from "../i18n"

export type QueueFamily = "decisions" | "design"

export interface QueueCounts {
  /** Waiting for the user: the pill. */
  readonly waiting: number
  /** Answers recorded that no session has received yet. */
  readonly queued: number
  /** Lines of the register that were thrown away. */
  readonly discarded: number
}

export interface QueueText {
  /** «Decisioni», «Design». */
  readonly name: string
  /** The pill: the count, always shown. */
  readonly pill: string
  /** «2 in coda», or nothing. */
  readonly queued?: string
  /** «14 scartate», or nothing. */
  readonly discarded?: string
  /** The accessible name: «Decisioni, 1 per te, 14 scartate». */
  readonly label: string
}

/** Whether the bar shows the button at all: something waits, is queued or was thrown away. */
export function queueShown(counts: QueueCounts): boolean {
  return counts.waiting > 0 || counts.queued > 0 || counts.discarded > 0
}

export function queueText(family: QueueFamily, counts: QueueCounts): QueueText {
  const name = t(family === "decisions" ? "decisions.title" : "design.title")
  const queued = counts.queued > 0 ? t("bar.queue.queued", counts.queued) : undefined
  const discarded = counts.discarded > 0 ? t("bar.queue.discarded", counts.discarded) : undefined
  const label = [name, t("bar.queue.forYou", counts.waiting), queued, discarded].filter(Boolean).join(", ")
  return {
    name,
    pill: String(counts.waiting),
    ...(queued ? { queued } : {}),
    ...(discarded ? { discarded } : {}),
    label,
  }
}
