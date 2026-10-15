/**
 * The orb, as a drawing.
 *
 * A sphere with an iris, the product's pot for a pupil, and two counter-rotating
 * arcs swimming under its surface: an eye when it is still, a moving fluid
 * when it is listening. It is not a microphone and never becomes one — the
 * microphone is the hardware, and this is the thing on the other side of it.
 *
 * Presentational on purpose. The toolbar wraps it in a button
 * (`voice-orb.tsx`); the HUD sits it in a pill as a decoration. Both were
 * drawing their own disc with the block mark inside before this, at two sizes
 * and with two different ideas of what "listening" looks like, so the widget
 * and the bar were two objects that happened to share a logo. One drawing,
 * two placements.
 *
 * Everything that moves is driven by one number, `--orb-level`, written on the
 * element from the microphone amplitude. The CSS derives the glow, the halo
 * and the arc strength from it, so there is one source of motion and no way
 * for the layers to disagree about how loud the room is.
 *
 * Sizing is one number too: `--orb-size` is the diameter and every layer is a
 * percentage of it, so the same drawing is a 28px control in a toolbar and a
 * 32px mark in a widget without a second set of rules.
 */

import type { DialogStatus } from "../dialog/session"
import type { VoiceMode } from "../settings/model"
import { orbSpins } from "./orb-spin"
import { POT_BOX, POT_RUNS } from "./pot-runs"
import "./orb-mark.css"

export interface OrbMarkProps {
  /** Whether the microphone is open. A shut orb is a closed lens. */
  awake: boolean
  /** The dialogue state, for the two conditions that need their own colour. */
  status: DialogStatus
  /**
   * Which of the two features has the microphone.
   *
   * There is one control and one microphone, so the orb is where the
   * difference is shown: the assistant circulates, dictation lets the words
   * through untouched and says so by holding still.
   */
  mode?: VoiceMode
  /** Microphone amplitude, 0…1, already smoothed by the caller. */
  level: number
  /**
   * A coloured ring around the sphere, or none.
   *
   * Named by meaning, not by colour — the stylesheet decides that green is
   * listening, red is broken and amber is "the microphone is not yours yet".
   * Carried as a prop rather than derived from `status` because two of the
   * three are not dialogue states at all: they are facts about the engine's
   * last failure, which the sphere itself knows nothing about.
   *
   * The toolbar passes nothing. It sits in a monochrome bar and has the whole
   * width of the window to be noticed in; the widget is a capsule floating
   * over a terminal, and the ring is what makes it readable at a glance from
   * the other side of the room.
   */
  rim?: OrbRim
}

export type OrbRim = "listening" | "failed" | "mic-auth"

export function OrbMark(props: OrbMarkProps) {
  return (
    <span
      data-component="orb-mark"
      data-status={props.awake ? props.status : "asleep"}
      data-awake={props.awake ? "true" : undefined}
      data-spin={orbSpins(props.awake, props.status, props.mode) ? "true" : undefined}
      data-mode={props.awake ? props.mode : undefined}
      data-rim={props.rim}
      style={{ "--orb-level": String(props.level) }}
      aria-hidden="true"
    >
      {/* The sphere's own shading, under everything that moves. */}
      <span data-slot="orb-body">
        {/* Two arcs, opposite directions and different speeds: one turning
            ring reads as a spinner, two reading against each other read as
            something circulating inside a sphere. */}
        <span data-slot="orb-swirl" data-arc="a" />
        <span data-slot="orb-swirl" data-arc="b" />
        <span data-slot="orb-iris" />
        {/* The glow the mark stands in — this is the part that dilates. */}
        <span data-slot="orb-pupil" />
        {/*
          The mark, as the pupil.

          Whose eye it is, said in the one place the eye is looking from: the
          Ragu Code pixel pot, the same runs the microphone draws. It was
          nikcli's N, three hand-drawn strokes, until the rename reached it.
          Pixels stay pixels: `crispEdges`, so at 40% of a 26px sphere the pot
          is a pot and not a blur.
        */}
        <svg
          data-slot="orb-mark-pot"
          viewBox={`0 0 ${POT_BOX.width} ${POT_BOX.height}`}
          shape-rendering="crispEdges"
        >
          <g fill="currentColor">
            {POT_RUNS.map(([x, y, w]) => (
              <rect x={x} y={y} width={w} height={1} />
            ))}
          </g>
        </svg>
        {/* Last, so the specular sits on top of the fluid and the whole thing
            keeps reading as one solid object rather than as stacked discs. */}
        <span data-slot="orb-gloss" />
      </span>
      {/* Outside the sphere, so a loud room lights the air around it without
          the orb itself changing size and shoving its neighbours along. */}
      <span data-slot="orb-halo" />
    </span>
  )
}
