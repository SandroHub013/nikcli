/**
 * Proactive voice alerts queue for ADE.
 *
 * Implements S48 consumption rules:
 * - Alerts speak of nik's own initiative for three events:
 *   1. A session requests a permission (the question with voice-answerable options)
 *   2. A session completes its work (brief, concrete sentence, e.g. "Prova-voce ha finito: tre test verdi.")
 *   3. An open decision is registered in the Decisions panel
 * - The alert speaks with the microphone closed.
 * - After an alert, a single 6-8s response window opens with a visible signal,
 *   only if the user enabled proactive alerts (`spokenAlerts === true`).
 * - Once expired, the window closes and does not reopen. No background listening.
 * - Rate limit: maximum 1 alert every 20 seconds (`ALERT_COOLDOWN_MS = 20_000`).
 * - Hourly cap: maximum 15 alerts per hour (`MAX_ALERTS_PER_HOUR = 15`), with a polite pause announcement.
 * - Max queue size: bounded to 10 alerts (`MAX_QUEUE_SIZE = 10`), oldest dropped on overflow.
 * - Silence when locked: no alerts spoken if the PC screen is locked.
 * - Deduplication: duplicate alerts for the same event are ignored (pruned after 1h, capped to 200).
 * - Disabled by default (`spokenAlerts: false`).
 */

import { t, translate, locale, type Locale } from "../i18n"

export const ALERT_COOLDOWN_MS = 20_000
export const RESPONSE_WINDOW_MS = 8_000
export const MAX_ALERTS_PER_HOUR = 15
export const MAX_QUEUE_SIZE = 10
export const SEEN_EVENTS_MAX_AGE_MS = 3_600_000
export const SEEN_EVENTS_MAX_SIZE = 200

export type AlertEvent =
  | {
      type: "permission"
      key: string
      paneId: string
      paneTitle: string
      what: string
    }
  | {
      type: "completion"
      key: string
      paneId: string
      paneTitle: string
      summary?: string
    }
  | {
      type: "decision"
      key: string
      k: string
      title?: string
    }

export interface ProactiveAlertsDeps {
  now(): number
  isLocked(): Promise<boolean>
  isEnabled(): boolean
  speak(text: string): Promise<void>
  openResponseWindow(options: {
    durationMs: number
    permission?: { paneId: string; what: string }
  }): Promise<void>
  isPermissionPending?(paneId: string): boolean
  isDecisionOpen?(k: string): boolean
}

/**
 * Parses recent terminal lines from a finished session to find concise test results or summary.
 * E.g. "3 passed" -> "tre test verdi" (it) or "three passed tests" (en).
 */
export function summarizeCompletion(lines: readonly { text: string }[], currentLocale?: Locale): string | undefined {
  if (!lines || lines.length === 0) return undefined
  const loc = currentLocale ?? locale()
  const numberNames: Record<Locale, Record<number, string>> = {
    it: {
      1: "un",
      2: "due",
      3: "tre",
      4: "quattro",
      5: "cinque",
      6: "sei",
      7: "sette",
      8: "otto",
      9: "nove",
      10: "dieci",
    },
    en: {
      1: "one",
      2: "two",
      3: "three",
      4: "four",
      5: "five",
      6: "six",
      7: "seven",
      8: "eight",
      9: "nine",
      10: "ten",
    },
  }

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 15); i--) {
    const text = lines[i]?.text ?? ""
    // Check for pass/green tests
    const passMatch = text.match(/(\d+)\s*(?:pass(?:ed)?|verdi|superati)/i)
    if (passMatch) {
      const count = parseInt(passMatch[1]!, 10)
      const numStr = (numberNames[loc] ?? numberNames.it)[count] ?? String(count)
      return translate(loc, "voice.alert.testsPassed", numStr)
    }
    // Check for failed tests
    const failMatch = text.match(/(\d+)\s*(?:fail(?:ed)?|falliti|errori)/i)
    if (failMatch) {
      const count = parseInt(failMatch[1]!, 10)
      const numStr = (numberNames[loc] ?? numberNames.it)[count] ?? String(count)
      return translate(loc, "voice.alert.testsFailed", numStr)
    }
  }
  return undefined
}

export function createProactiveAlerts(deps: ProactiveAlertsDeps) {
  const queue: AlertEvent[] = []
  const seenEvents = new Map<string, number>()
  let alertTimestamps: number[] = []
  let capAnnounced = false
  let lastAlertAt = 0
  let isProcessing = false

  function pruneSeenEvents(nowMs: number): void {
    const cutoff = nowMs - SEEN_EVENTS_MAX_AGE_MS
    for (const [key, timestamp] of seenEvents) {
      if (timestamp < cutoff) {
        seenEvents.delete(key)
      }
    }
    if (seenEvents.size > SEEN_EVENTS_MAX_SIZE) {
      const toRemove = seenEvents.size - SEEN_EVENTS_MAX_SIZE
      let removed = 0
      for (const key of seenEvents.keys()) {
        if (removed >= toRemove) break
        seenEvents.delete(key)
        removed++
      }
    }
  }

  function pruneHourlyTimestamps(nowMs: number): void {
    const cutoff = nowMs - 3_600_000
    alertTimestamps = alertTimestamps.filter((t) => t > cutoff)
    if (alertTimestamps.length < MAX_ALERTS_PER_HOUR) {
      capAnnounced = false
    }
  }

  async function announceCap(): Promise<void> {
    if (capAnnounced) return
    capAnnounced = true
    queue.length = 0
    await deps.speak(t("voice.alert.capReached", MAX_ALERTS_PER_HOUR)).catch(() => {})
  }

  async function processQueue(): Promise<void> {
    if (isProcessing) return
    if (!deps.isEnabled()) {
      queue.length = 0
      return
    }

    isProcessing = true
    try {
      while (queue.length > 0) {
        if (!deps.isEnabled()) {
          queue.length = 0
          break
        }

        const nowMs = deps.now()
        pruneHourlyTimestamps(nowMs)

        if (alertTimestamps.length >= MAX_ALERTS_PER_HOUR) {
          await announceCap()
          break
        }

        const elapsed = nowMs - lastAlertAt
        if (lastAlertAt > 0 && elapsed < ALERT_COOLDOWN_MS) {
          await new Promise((resolve) => setTimeout(resolve, ALERT_COOLDOWN_MS - elapsed))
          if (!deps.isEnabled()) break
        }

        const event = queue.shift()
        if (!event) break

        // Check if locked
        const locked = await deps.isLocked().catch(() => true)
        if (locked) continue

        // Check staleness
        if (event.type === "permission" && deps.isPermissionPending && !deps.isPermissionPending(event.paneId)) {
          continue
        }
        if (event.type === "decision" && deps.isDecisionOpen && !deps.isDecisionOpen(event.k)) {
          continue
        }

        // Formulate spoken text
        let phrase = ""
        if (event.type === "permission") {
          phrase = t("voice.alert.permission", event.paneTitle, event.what)
        } else if (event.type === "completion") {
          phrase = event.summary
            ? t("voice.alert.completed", event.paneTitle, event.summary)
            : t("voice.alert.completedSimple", event.paneTitle)
        } else if (event.type === "decision") {
          phrase = t("voice.alert.decision", event.title || event.k)
        }

        if (!phrase) continue

        const alertTime = deps.now()
        lastAlertAt = alertTime
        alertTimestamps.push(alertTime)

        // 1. Speak alert with microphone closed
        await deps.speak(phrase).catch(() => {})

        // Check if this alert hit the hourly cap
        if (alertTimestamps.length >= MAX_ALERTS_PER_HOUR) {
          await announceCap()
          break
        }

        // 2. Open single response window
        if (deps.isEnabled()) {
          const permissionParam =
            event.type === "permission"
              ? { paneId: event.paneId, what: event.what }
              : undefined
          await deps.openResponseWindow({
            durationMs: RESPONSE_WINDOW_MS,
            permission: permissionParam,
          }).catch(() => {})
        }
      }
    } finally {
      isProcessing = false
    }
  }

  function enqueue(event: AlertEvent): void {
    if (!deps.isEnabled()) return
    const nowMs = deps.now()
    pruneHourlyTimestamps(nowMs)
    if (alertTimestamps.length >= MAX_ALERTS_PER_HOUR) {
      if (!capAnnounced) {
        void announceCap()
      }
      return
    }

    pruneSeenEvents(nowMs)
    if (seenEvents.has(event.key)) return
    seenEvents.set(event.key, nowMs)

    if (queue.length >= MAX_QUEUE_SIZE) {
      queue.shift()
    }
    queue.push(event)
    void processQueue()
  }

  return {
    notifyPermission(paneId: string, paneTitle: string, what: string): void {
      enqueue({
        type: "permission",
        key: `perm:${paneId}:${what}`,
        paneId,
        paneTitle,
        what,
      })
    },

    notifyCompletion(paneId: string, paneTitle: string, lines: readonly { text: string }[], turnId?: string | number): void {
      const summary = summarizeCompletion(lines)
      const turnKey = turnId !== undefined ? String(turnId) : `${lines.length}`
      enqueue({
        type: "completion",
        key: `comp:${paneId}:${turnKey}`,
        paneId,
        paneTitle,
        summary,
      })
    },

    notifyDecision(k: string, title?: string): void {
      enqueue({
        type: "decision",
        key: `dec:${k}`,
        k,
        title,
      })
    },

    getQueueLength(): number {
      return queue.length
    },

    clear(): void {
      queue.length = 0
      seenEvents.clear()
      alertTimestamps = []
      capAnnounced = false
    },
  }
}
