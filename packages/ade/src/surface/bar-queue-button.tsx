import { createSignal, onCleanup, Show } from "solid-js"
import type { ResolvedTheme } from "../theme"
import { NARROW_BAR, queueText, queueTitle, type QueueCounts, type QueueFamily } from "./bar-queue"
import { VialMark } from "./vial/vial-mark"

/**
 * Decisioni and Design in the bar, one component for both (DS-polish, closures
 * 3 to 6): the vial, the name, the count in a pill of the family's colour, and
 * what is queued or discarded in small soft text with a dot. The text is the
 * bar's ink; the colour is only in the pill and the focus ring.
 *
 * Under 1100 px the name and the asides give way to the vial and the pill (the
 * stylesheet does it); the accessible name keeps every word, and so does the
 * tooltip, which is there only then.
 */
export function BarQueueButton(props: {
  family: QueueFamily
  counts: QueueCounts
  /** Its panel is open. */
  open: boolean
  theme: ResolvedTheme
  onOpen: () => void
}) {
  const text = () => queueText(props.family, props.counts)
  const query = typeof matchMedia === "function" ? matchMedia(NARROW_BAR) : undefined
  const [narrow, setNarrow] = createSignal(query?.matches ?? false)
  const follow = (event: MediaQueryListEvent) => setNarrow(event.matches)
  query?.addEventListener("change", follow)
  onCleanup(() => query?.removeEventListener("change", follow))
  return (
    <button
      type="button"
      data-slot="bar-queue"
      data-family={props.family}
      data-open={props.open ? "true" : undefined}
      data-queued={props.counts.queued > 0 ? "" : undefined}
      data-discarded={props.counts.discarded > 0 ? "" : undefined}
      aria-label={text().label}
      title={queueTitle(text(), narrow())}
      aria-haspopup="dialog"
      aria-expanded={props.open}
      onClick={() => props.onOpen()}
    >
      <span data-slot="bar-queue-vial" aria-hidden="true">
        <VialMark fam={props.family === "design" ? "design" : "dec"} count={props.counts.waiting} theme={props.theme} />
      </span>
      <span data-slot="bar-queue-name">{text().name}</span>
      <span data-slot="bar-queue-pill">{text().pill}</span>
      <Show when={text().queued}>
        {(queued) => (
          <span data-slot="bar-queue-aside" data-tone="warn">
            <span data-slot="bar-queue-dot" aria-hidden="true" />
            {queued()}
          </span>
        )}
      </Show>
      <Show when={text().discarded}>
        {(discarded) => (
          <span data-slot="bar-queue-aside" data-tone="error">
            <span data-slot="bar-queue-dot" aria-hidden="true" />
            {discarded()}
          </span>
        )}
      </Show>
    </button>
  )
}
