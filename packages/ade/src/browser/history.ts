/**
 * The browser pane's own back/forward list.
 *
 * The frame's `history` cannot serve: the frame is sandboxed without
 * `allow-same-origin`, so its window is cross-origin to ADE and reading
 * `contentWindow.history` throws. It also dies with the frame, and the frame
 * is rebuilt whenever the pane is drawn again — switching project and back
 * is enough. This list lives in the workbench instead, so it comes back with
 * the pane, and is saved with it.
 *
 * It records what the pane loaded (address bar, back, forward), not links
 * followed inside the page: those happen in a document ADE cannot read.
 */

export interface BrowserHistory {
  entries: string[]
  index: number
}

/** Enough to go back through a working session, small enough to save with every autosave. */
export const HISTORY_LIMIT = 50

export function startHistory(url: string): BrowserHistory {
  return { entries: [url], index: 0 }
}

/** The page being shown. */
export function currentEntry(history: BrowserHistory): string {
  return history.entries[history.index] ?? ""
}

/**
 * A new page: what was ahead of the current one is dropped, as in any browser.
 * Loading the page already shown is not a new entry.
 */
export function visit(history: BrowserHistory, url: string): BrowserHistory {
  if (currentEntry(history) === url) return history
  const entries = [...history.entries.slice(0, history.index + 1), url].slice(-HISTORY_LIMIT)
  return { entries, index: entries.length - 1 }
}

export function canStep(history: BrowserHistory, delta: -1 | 1): boolean {
  const next = history.index + delta
  return next >= 0 && next < history.entries.length
}

/** Back (-1) or forward (+1); the same history when there is nowhere to go. */
export function step(history: BrowserHistory, delta: -1 | 1): BrowserHistory {
  return canStep(history, delta) ? { entries: history.entries, index: history.index + delta } : history
}

/**
 * The history a pane opens with.
 *
 * A saved one is used only when it is whole and its current entry is the
 * pane's URL; anything else starts over from the URL, which is the one thing
 * the pane is known to show.
 */
export function restoreHistory(url: string, saved: unknown): BrowserHistory {
  if (!saved || typeof saved !== "object") return startHistory(url)
  const { entries, index } = saved as { entries?: unknown; index?: unknown }
  if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) return startHistory(url)
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= entries.length) {
    return startHistory(url)
  }
  if (entries[index] !== url) return startHistory(url)
  const kept = entries.slice(-HISTORY_LIMIT)
  const keptIndex = index - (entries.length - kept.length)
  return keptIndex < 0 ? startHistory(url) : { entries: kept, index: keptIndex }
}
