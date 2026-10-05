import { createSignal, Show, type JSX } from "solid-js"

let nextHowItWorksId = 0

export interface HowItWorksProps {
  /** The label shown next to the chevron (defaults to "Come funziona"). */
  title?: JSX.Element | string
  /** The hidden explanation revealed when expanded. */
  children?: JSX.Element
  /** Starts open if true; defaults to false. */
  defaultOpen?: boolean
  class?: string
  id?: string
}

/**
 * Collapsible disclosure block for detailed explanations («Come funziona»).
 *
 * Keeps verbose documentation out of the primary settings flow while leaving
 * it immediately reachable in-place.
 */
export function HowItWorks(props: HowItWorksProps): JSX.Element {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  const contentId = props.id ?? `how-it-works-${++nextHowItWorksId}`

  const labelText = () => (typeof props.title === "string" ? props.title : "Come funziona")

  return (
    <div data-slot="how-it-works" class={props.class}>
      <button
        type="button"
        data-slot="how-it-works-toggle"
        aria-expanded={open()}
        aria-controls={contentId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span
          data-slot="how-it-works-chevron"
          aria-hidden="true"
          data-open={open() ? "true" : undefined}
        />
        <span data-slot="how-it-works-title">{props.title ?? "Come funziona"}</span>
      </button>
      <Show when={open()}>
        <div
          id={contentId}
          data-slot="how-it-works-content"
          role="region"
          aria-label={labelText()}
        >
          {props.children}
        </div>
      </Show>
    </div>
  )
}
