/*
 * One run per key at a time (review of the frontend, ALTO 3).
 *
 * `reopen` asked once, before its awaits, whether the pane already had a
 * process; the process is recorded only once it has started. A second click
 * on «Riprendi», or the restore reaching the same pane, came in between and
 * started a second process for the same pane, the first one left running
 * with nothing to show it or end it.
 */

export interface OneAtATime {
  /** Runs `work` unless a run for `key` is under way; true when it ran. */
  readonly run: (key: string, work: () => Promise<unknown>) => Promise<boolean>
  readonly busy: (key: string) => boolean
}

export function oneAtATime(): OneAtATime {
  const under = new Set<string>()
  return {
    run: async (key, work) => {
      if (under.has(key)) return false
      under.add(key)
      try {
        await work()
        return true
      } finally {
        under.delete(key)
      }
    },
    busy: (key) => under.has(key),
  }
}
