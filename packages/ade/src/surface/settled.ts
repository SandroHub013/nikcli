/**
 * A count that shows only once it has stayed above zero for `ms`.
 *
 * After the last answer the «Da scegliere» button showed «0» for a moment
 * and went (Verifiche, ultimi 2): the answer sat in the outbox for the half
 * second before the pane that asked took it, and a queued answer keeps the
 * button up. One that waits longer, with nobody to take it, still shows.
 * Back to zero, and higher while it shows, at once.
 */
import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js"

/** Longer than a delivery to a running pane, which is about half a second. */
export const QUEUED_SETTLE_MS = 2000

export function createSettled(source: Accessor<number>, ms = QUEUED_SETTLE_MS): Accessor<number> {
  const [value, setValue] = createSignal(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  createEffect(() => {
    const count = source()
    if (count === 0) {
      stop()
      setValue(0)
      return
    }
    if (untrack(value) > 0) {
      setValue(count)
      return
    }
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      setValue(untrack(source))
    }, ms)
  })
  onCleanup(stop)
  return value
}
