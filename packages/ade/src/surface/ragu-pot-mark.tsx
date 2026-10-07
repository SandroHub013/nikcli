import type { JSX } from "solid-js"
import { potRuns } from "./ragu-pot"

const RUNS = potRuns()

/**
 * The Ragu Code mark in the bar: the pixel pot of the logo, one SVG rect per run of a colour on a row, with
 * crisp edges so it stays pixel art at any scale. Still: no loop, no frame.
 */
export function RaguPotMark(props: { size?: number }): JSX.Element {
  const size = () => props.size ?? 30
  return (
    <svg
      data-component="ragu-pot-mark"
      width={size()}
      height={size()}
      viewBox="0 0 16 16"
      shape-rendering="crispEdges"
      aria-hidden="true"
    >
      {RUNS.map(([x, y, width, fill]) => (
        <rect x={x} y={y} width={width} height={1} fill={fill} />
      ))}
    </svg>
  )
}
