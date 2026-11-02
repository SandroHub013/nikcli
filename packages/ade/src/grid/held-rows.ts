import { createEffect, createSignal, onCleanup, untrack } from "solid-js"

/**
 * How often the rows of a transcript nobody can see are built.
 *
 * Behind a live terminal the transcript is `display: none`, and it stays mounted so it can show up when the process is
 * gone. A flood's chunk replaced all its 200 rows: half of what a flood allocated, 123 MB for 30 MiB, and it reached
 * the old space faster than the automatic GCs freed it, so the renderer passed 2 GB after 340 MB of output.
 */
export const HELD_ROWS_MS = 250

/**
 * What the transcript should draw: `lines` as they are when it is on screen, and at most every `ms` while it is hidden.
 *
 * On a timer, so the last chunk of a burst is drawn too. A minimised window runs it late, and nobody is looking.
 */
export function createHeldRows<T>(
  lines: () => T,
  hidden: () => boolean,
  ms: number = HELD_ROWS_MS,
): () => T {
  const [held, setHeld] = createSignal<T>(untrack(lines))
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    lines()
    if (timer !== undefined || !hidden()) return
    timer = setTimeout(() => {
      timer = undefined
      setHeld(() => untrack(lines))
    }, ms)
  })
  onCleanup(() => clearTimeout(timer))
  return () => (hidden() ? held() : lines())
}
