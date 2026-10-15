/**
 * The ragu microphone — the product's pixel pot drawn inside a mic capsule.
 *
 * A generic microphone glyph says "audio" and nothing else; every app that
 * listens has one. This one says whose it is: the capsule is the head of the
 * mic and the Ragu Code pixel pot stands inside it, with the pickup cradle
 * and stem beneath. At a glance it reads as a microphone; on a second look it
 * reads as the pot mark, which is the right order for a mark that has to work
 * at 14px-18px in a toolbar.
 *
 * Two cuts, because one drawing cannot do both jobs:
 *
 *   line   — hairline capsule, pot drawn inside it. Enough air to sit next to
 *            a heading without shouting.
 *   solid  — capsule filled, pot knocked out of the fill. Holds its shape at
 *            14px and reads as a state indicator, which is what a toolbar
 *            button and a live widget need.
 *
 * The geometry is shared: the same capsule, the same pot, so the two cuts are
 * the same mark and not two marks that resemble each other.
 */

import type { JSX } from "solid-js"
import { POT_RUNS } from "./pot-runs"

export interface RaguMicProps {
  /** Rendered edge length in px. The drawing is square. */
  size?: number
  /** Which cut to draw. Defaults to the hairline. */
  variant?: "line" | "solid"
  /**
   * Colour of the pot mark in the solid cut — it is knocked out of the fill,
   * so it has to match whatever sits behind the mark rather than inherit from it.
   */
  knockout?: string
  class?: string
}

/*
 * One geometry, named once.
 *
 * The capsule is 9 wide inside a 24 box. The pixel pot (from POT_16) is
 * scaled and centred inside the capsule.
 */
const CAPSULE = { x: 7.5, y: 2, w: 9, h: 12.5, r: 4.5 }

/** The cradle and stem, identical in both cuts. */
function Cradle(props: { width: number }) {
  return (
    <>
      <path
        d="M4.5 11.5v1a7.5 7.5 0 0 0 15 0v-1"
        fill="none"
        stroke="currentColor"
        stroke-width={props.width}
        stroke-linecap="round"
      />
      <path d="M12 20v2" fill="none" stroke="currentColor" stroke-width={props.width} stroke-linecap="round" />
    </>
  )
}

export function RaguMic(props: RaguMicProps): JSX.Element {
  const size = () => props.size ?? 16
  const solid = () => props.variant === "solid"

  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      class={props.class}
      data-component="ragu-mic"
      data-variant={solid() ? "solid" : "line"}
      aria-hidden="true"
    >
      <rect
        x={CAPSULE.x}
        y={CAPSULE.y}
        width={CAPSULE.w}
        height={CAPSULE.h}
        rx={CAPSULE.r}
        fill={solid() ? "currentColor" : "none"}
        stroke={solid() ? "none" : "currentColor"}
        stroke-width="1.6"
      />

      {/* The Ragu Code pixel pot inside the capsule */}
      <g
        transform="translate(8.4, 5.1) scale(0.45)"
        shape-rendering="crispEdges"
      >
        {POT_RUNS.map(([x, y, w]) => (
          <rect
            x={x}
            y={y}
            width={w}
            height={1}
            fill={solid() ? (props.knockout ?? "var(--ade-accent-fg, #fff)") : "currentColor"}
          />
        ))}
      </g>

      <Cradle width={solid() ? 1.9 : 1.6} />
    </svg>
  )
}
