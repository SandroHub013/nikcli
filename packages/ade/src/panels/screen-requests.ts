/**
 * Requests read from what a pane shows, for the agents that draw a screen.
 *
 * `onLine` reads the pty's bytes split on newlines, and that is where the
 * requests of an agent that prints lines are found. A TUI that draws with the
 * cursor (nikcli, on the alternate screen) never writes one: it places every
 * word with a cursor move, and the stream of a whole turn reaches `onLine` as a
 * few 8 KB runs of text, the words of the screen interleaved and the spaces
 * between them gone (`@adekeysaskADE_PROVA_FINTA…`, Verifiche and Dario,
 * 2026-09-27). The line is only whole on the screen, so it is read there.
 *
 * When: once the pane's output has been quiet for `SCREEN_QUIET_MS`. A turn
 * streams its text word by word with a spinner turning beside it, so a row
 * read while it is drawn would be half a request (`@ade keys ask ADE_PRO`);
 * quiet is the turn over, which is also when the agent waits for the answer.
 *
 * Which: a row that is a request (`parseRequest`) and was not on the screen
 * before. The screen is drawn again for every reason there is — a resize, a
 * scroll up and back, a tab switched — and a request already acted on must
 * not be acted on again because it came back into view. So an identical row
 * counts only when there are more copies of it on the screen at once than
 * there have ever been: the same request written again while the first is
 * still visible is read, one written again after the first scrolled away is
 * not (the price of not reading a scroll as a request).
 *
 * Pure but for the timers, which are injected, so the rule is tested on a
 * real terminal fed a real capture.
 */

import { parseRequest } from "./protocol"

/** How long a pane's output stays quiet before its screen is read. */
export const SCREEN_QUIET_MS = 700

/**
 * How long a restored conversation takes to be drawn again, during which what
 * the screen shows is the old conversation: its requests were acted on when
 * they were written. A time, not the first reading: nikcli can be quiet on a
 * loading screen before it draws the conversation.
 */
export const RESTORED_MS = 10_000

/** The visible rows of `terminal`'s screen, if it is the alternate one. */
export function alternateRows(terminal: {
  readonly rows: number
  readonly buffer: {
    readonly active: {
      readonly type: string
      readonly viewportY: number
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined
    }
  }
}): string[] | undefined {
  const screen = terminal.buffer.active
  if (screen.type !== "alternate") return undefined
  const rows: string[] = []
  for (let y = 0; y < terminal.rows; y++) rows.push(screen.getLine(screen.viewportY + y)?.translateToString(true) ?? "")
  return rows
}

/**
 * The requests among `rows` that are new, given the most copies of each seen
 * at once so far (`peak`, updated). With `baseline`, nothing is new: the
 * screen a restored conversation opens on is what was already acted on.
 */
export function newRequests(rows: readonly string[], peak: Map<string, number>, baseline = false): string[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!parseRequest(row)) continue
    const text = row.trim()
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  const fresh: string[] = []
  for (const [text, count] of counts) {
    const before = peak.get(text) ?? 0
    if (count <= before) continue
    peak.set(text, count)
    if (!baseline) for (let i = before; i < count; i++) fresh.push(text)
  }
  return fresh
}

export interface ScreenRequestsDeps {
  /** The pane's rows, or undefined when it is not drawing a screen. */
  readonly rows: (paneId: string) => readonly string[] | undefined
  readonly onRequest: (paneId: string, line: string) => void
  readonly quietMs?: number
  readonly now?: () => number
  readonly setTimer?: (run: () => void, ms: number) => unknown
  readonly clearTimer?: (timer: unknown) => void
}

export interface ScreenRequests {
  /** Output reached `paneId`: its screen is read once it goes quiet. */
  fed(paneId: string): void
  /** A process starts in `paneId`; `restored` when it reopens a conversation. */
  start(paneId: string, restored: boolean): void
  forget(paneId: string): void
}

export function createScreenRequests(deps: ScreenRequestsDeps): ScreenRequests {
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const timers = new Map<string, unknown>()
  const peaks = new Map<string, Map<string, number>>()
  const now = deps.now ?? Date.now
  /** Until when each restored pane's screen is the old conversation. */
  const baselines = new Map<string, number>()

  const read = (paneId: string) => {
    timers.delete(paneId)
    const rows = deps.rows(paneId)
    if (!rows) return
    let peak = peaks.get(paneId)
    if (!peak) peaks.set(paneId, (peak = new Map()))
    const until = baselines.get(paneId)
    const baseline = until !== undefined && now() < until
    if (!baseline) baselines.delete(paneId)
    for (const line of newRequests(rows, peak, baseline)) deps.onRequest(paneId, line)
  }

  return {
    fed(paneId) {
      const pending = timers.get(paneId)
      if (pending !== undefined) clearTimer(pending)
      timers.set(
        paneId,
        setTimer(() => read(paneId), deps.quietMs ?? SCREEN_QUIET_MS),
      )
    },
    start(paneId, restored) {
      this.forget(paneId)
      if (restored) baselines.set(paneId, now() + RESTORED_MS)
    },
    forget(paneId) {
      const pending = timers.get(paneId)
      if (pending !== undefined) clearTimer(pending)
      timers.delete(paneId)
      peaks.delete(paneId)
      baselines.delete(paneId)
    },
  }
}
