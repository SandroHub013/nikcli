import { createSignal, Show, type JSX } from "solid-js"

let nextHowItWorksId = 0

export interface HowItWorksProps {
  /** The label next to the chevron, already translated by the caller. */
  title: string
  /** The explanation revealed when open. */
  children?: JSX.Element
  /** Starts open when true; closed otherwise. */
  defaultOpen?: boolean
}

/**
 * The long explanation of a settings page, folded away until it is asked for.
 *
 * A button that carries `aria-expanded`, and a panel that exists only while
 * open: the sentence above stays short, and what the page does not need to say
 * on every visit is one press away. It styles through `data-slot` only, so the
 * host (ADE or the voice panel) owns how it looks.
 */
export function HowItWorks(props: HowItWorksProps): JSX.Element {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  const id = `how-it-works-${++nextHowItWorksId}`

  return (
    <div data-slot="how-it-works">
      <button
        type="button"
        id={`${id}-toggle`}
        data-slot="how-it-works-toggle"
        aria-expanded={open()}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((value) => !value)}
      >
        <span data-slot="how-it-works-chevron" aria-hidden="true" />
        <span data-slot="how-it-works-title">{props.title}</span>
      </button>
      <Show when={open()}>
        <div id={`${id}-panel`} data-slot="how-it-works-panel" role="region" aria-labelledby={`${id}-toggle`}>
          {props.children}
        </div>
      </Show>
    </div>
  )
}
