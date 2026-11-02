/**
 * Says in the log when the page's thread was held for a long time.
 *
 * Live test 2026-11-02, B: `close` and `relaunch` stalled `ade-msg kv` for 6 to 8 s, against the client's 10 s. `kv`
 * has no lane, the native commands behind the mail are `async` and the kill runs on the blocking pool, so what is left
 * is the page's own thread being held, or something native that this cannot see. A long task in the log, at the time
 * of a close, says it is the first; none says it is not. Quiet below the threshold: it is a diagnosis, not a feed.
 */

/** A task this long is worth a line: the mail round and every receipt wait behind it. */
export const LONG_TASK_LOG_MS = 1_500

interface TaskEntry {
  readonly startTime: number
  readonly duration: number
}

interface ObserverLike {
  observe: (options: { entryTypes: string[] }) => void
  disconnect: () => void
}

/**
 * Starts logging the page's long tasks; returns the function that stops it. Does nothing, and returns a function that
 * does nothing, where the browser has no long-task entries.
 */
export function watchLongTasks(
  log: (text: string) => void,
  scope: {
    PerformanceObserver?: {
      new (callback: (list: { getEntries: () => TaskEntry[] }) => void): ObserverLike
      supportedEntryTypes?: readonly string[]
    }
  } = globalThis as never,
  thresholdMs: number = LONG_TASK_LOG_MS,
): () => void {
  const Observer = scope.PerformanceObserver
  if (!Observer || !Observer.supportedEntryTypes?.includes("longtask")) return () => {}
  try {
    const observer = new Observer((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= thresholdMs) {
          log(`ADE: la pagina è rimasta ferma ${Math.round(entry.duration)} ms (dal ${Math.round(entry.startTime)} ms della pagina)`)
        }
      }
    })
    observer.observe({ entryTypes: ["longtask"] })
    return () => observer.disconnect()
  } catch {
    return () => {}
  }
}
