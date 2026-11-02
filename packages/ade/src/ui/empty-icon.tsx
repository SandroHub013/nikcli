import type { JSX } from "solid-js"
import "./empty-icon.css"

/**
 * The neutral line icon an empty view carries (DS-17), in the soft circle of the approved mock: 24 grid, 1.5 stroke, round ends, `currentColor`, so the
 * sheet decides its colour and size. One per view. The pixel pot is not here on purpose: it is for the screen
 * with no project (`surface/empty-project.tsx`), and anywhere else it would stop meaning «this is Ragu Code».
 *
 * The mark that goes into the shared `EmptyState` (`ui/controls.tsx`): `<EmptyState mark={<EmptyIcon name="chat" />} …>`.
 * It holds only the icon; the title, the line of help and the action are the component's.
 */
export const EMPTY_ICONS = {
  /** A prompt in a terminal window. */
  agent: "M4 5.5h16v13H4z M7.5 10l2.5 2-2.5 2 M12.5 14.5H16.5",
  /** A speech bubble. */
  chat: "M4.5 5.5h15v10h-8.5l-4 3.5v-3.5h-2.5z",
  /** A solid, seen corner-on. */
  model: "M12 3.5l8 4.5v8.5l-8 4.5-8-4.5V8z M4 8l8 4.5L20 8 M12 12.5V20.5",
  /** A ticked box. */
  decisions: "M4.5 4.5h15v15h-15z M8 12.5l2.7 2.7L16 9.5",
  /** A brush. */
  design: "M4 20l4.5-1 10.2-10.2a2.1 2.1 0 0 0-3-3L5.5 16z M14 7.5l2.5 2.5",
} as const

export type EmptyIconName = keyof typeof EMPTY_ICONS

export function EmptyIcon(props: { name: EmptyIconName }): JSX.Element {
  return (
    <span data-slot="empty-icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        {EMPTY_ICONS[props.name].split(" M").map((part, index) => (
          <path d={index === 0 ? part : `M${part}`} />
        ))}
      </svg>
    </span>
  )
}
