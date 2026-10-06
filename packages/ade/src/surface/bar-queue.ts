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

/** The two queue families in the bar (Decisioni and Design). */
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

/**
 * The width under which the buttons lose their words (dev.css says the same
 * in its `@media`): only the vial and the pill are left.
 */
export const NARROW_BAR = "(max-width: 1099.98px)"

/**
 * The tooltip, only on the narrow bar (review of piece 1). With the name on
 * the button a title would repeat it (closure 4); without it, a mouse user
 * has only the vial to tell Decisioni from Design, and no way to learn what
 * the number is.
 */
export function queueTitle(text: QueueText, narrow: boolean): string | undefined {
  return narrow ? text.label : undefined
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

/** Accessible label and tooltip for a pill queue button item in the bar (T1). */
export function queueItemLabel(family: "decisions" | "design", waiting: number, queued = 0): string {
  const name = t(family === "decisions" ? "decisions.title" : "design.title")
  const forYou = waiting > 0 ? t("bar.queue.forYou", waiting) : undefined
  const queuedText = queued > 0 ? t("bar.queue.queued", queued) : undefined
  return [name, forYou, queuedText].filter(Boolean).join(", ")
}

/**
 * Returns the items from `open` whose keys are not in `seen`, and adds them to `seen`.
 * Used to detect genuinely new items arriving in registers (O2).
 */
export function newlyOpened<T extends { k: string }>(seen: Set<string>, open: readonly T[]): T[] {
  const fresh: T[] = []
  for (const item of open) {
    if (!seen.has(item.k)) {
      seen.add(item.k)
      fresh.push(item)
    }
  }
  return fresh
}

export interface OpenKeyTracker<T extends { k: string }> {
  readonly seen: ReadonlySet<string>
  update(projectRoot: string | undefined, open: readonly T[]): T[]
  reset(): void
}

/**
 * Tracks open register keys across project changes and first loads (O2).
 * Establishes a baseline on the initial load of each project without alerting.
 * Returns only items whose keys are newly added to an already loaded project.
 */
export function createOpenKeyTracker<T extends { k: string }>(): OpenKeyTracker<T> {
  let trackedRoot: string | undefined = undefined
  let initialized = false
  const seen = new Set<string>()

  return {
    get seen() {
      return seen
    },
    update(projectRoot, open) {
      if (projectRoot !== trackedRoot) {
        trackedRoot = projectRoot
        seen.clear()
        initialized = false
      }
      if (!initialized) {
        for (const item of open) seen.add(item.k)
        initialized = true
        return []
      }
      return newlyOpened(seen, open)
    },
    reset() {
      trackedRoot = undefined
      initialized = false
      seen.clear()
    },
  }
}
