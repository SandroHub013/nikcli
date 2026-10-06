/**
 * Accessible labels and tracking for the two queue buttons in the bar,
 * Decisioni and Design (T1).
 */
import { t } from "../i18n"

/** The two queue families in the bar (Decisioni and Design). */
export type QueueFamily = "decisions" | "design"

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
  update(registerPath: string | undefined, open: readonly T[]): T[]
  reset(): void
}

/**
 * Tracks open register keys across register path changes and first loads (O2, D1).
 * Establishes a baseline on the initial load of each register path without alerting.
 * Returns only items whose keys are newly added to an already loaded register.
 */
export function createOpenKeyTracker<T extends { k: string }>(): OpenKeyTracker<T> {
  let trackedPath: string | undefined = undefined
  let initialized = false
  const seen = new Set<string>()

  return {
    get seen() {
      return seen
    },
    update(registerPath, open) {
      if (registerPath !== trackedPath) {
        trackedPath = registerPath
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
      trackedPath = undefined
      initialized = false
      seen.clear()
    },
  }
}
