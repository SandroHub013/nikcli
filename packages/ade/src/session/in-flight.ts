/**
 * The lines ADE has queued or is typing, per pane.
 *
 * A round asks each held line whether its pane is free, and starts the
 * delivery without waiting for it: the text, the 2.5-8 s before the Enter,
 * then the CLI's hook saying a turn began. Until then the pane still read as
 * free, so a second line for the same pane in the same round was typed too,
 * mid-turn (review area 2, MEDIO). A pane with a line on its way is not free.
 */
export function createInFlight() {
  const counts = new Map<string, number>()
  return {
    has: (key: string) => (counts.get(key) ?? 0) > 0,
    /** Counts `work` for `key` until it settles, however it settles. */
    track<T>(key: string, work: Promise<T>): Promise<T> {
      counts.set(key, (counts.get(key) ?? 0) + 1)
      return work.finally(() => {
        const left = (counts.get(key) ?? 1) - 1
        if (left > 0) counts.set(key, left)
        else counts.delete(key)
      })
    },
  }
}
