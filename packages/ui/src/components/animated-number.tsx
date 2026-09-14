import { createEffect, createSignal, onCleanup, untrack, type ComponentProps } from "solid-js"

export interface AnimatedNumberProps {
  value: number
  /** Turns the tweened number into its display string. */
  format?: (value: number) => string
  /** Milliseconds for the full run. */
  duration?: number
  class?: string
  classList?: ComponentProps<"span">["classList"]
}

const easeOutExpo = (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t))

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

/**
 * Counts from the previous value to the next one. Every stat in the analytics
 * view lands at the same time, which is what makes the panel feel alive rather
 * than merely populated.
 */
export function AnimatedNumber(props: AnimatedNumberProps) {
  const [display, setDisplay] = createSignal(props.value)

  createEffect(() => {
    const target = props.value
    // Start from what is on screen, not from the previous target: a value that
    // changes mid-run would otherwise snap back to where the last run was headed
    // before counting again.
    const from = untrack(display)

    if (from === target || prefersReducedMotion()) {
      setDisplay(target)
      return
    }

    const duration = props.duration ?? 700
    let frame = 0
    let start: number | undefined

    const step = (now: number) => {
      start ??= now
      const progress = Math.min(1, (now - start) / duration)
      setDisplay(from + (target - from) * easeOutExpo(progress))
      if (progress < 1) frame = requestAnimationFrame(step)
    }

    frame = requestAnimationFrame(step)
    onCleanup(() => cancelAnimationFrame(frame))
  })

  return (
    <span
      classList={{
        ...(props.classList ?? {}),
        [props.class ?? ""]: !!props.class,
      }}
    >
      {props.format ? props.format(display()) : Math.round(display())}
    </span>
  )
}
