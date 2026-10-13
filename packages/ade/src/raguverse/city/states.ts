/**
 * From a session's state to what the city shows for it. The state is ADE's own
 * (`resolvePaneState`), passed on unchanged; this only says how it looks.
 */

import type { PaneState } from "../../grid/pane-state"

export type Pose = "type" | "raise-hand" | "turn" | "head-hands" | "lean-back" | "sit" | "away"

export interface StateLook {
  pose: Pose
  /** The monitor is lit. */
  screen: boolean
  /** The colour of the monitor and of the light on it. */
  glow: "cool" | "amber" | "blue" | "red" | "dim" | "off"
  /** A mark floating over the head, when the session needs the user. */
  signal: "none" | "attention" | "question"
  /** Somebody sits at the desk. */
  present: boolean
}

export const STATE_LOOK: Readonly<Record<PaneState, StateLook>> = {
  work: { pose: "type", screen: true, glow: "cool", signal: "none", present: true },
  perm: { pose: "raise-hand", screen: true, glow: "amber", signal: "attention", present: true },
  ask: { pose: "turn", screen: true, glow: "blue", signal: "question", present: true },
  err: { pose: "head-hands", screen: true, glow: "red", signal: "none", present: true },
  limit: { pose: "lean-back", screen: true, glow: "dim", signal: "none", present: true },
  idle: { pose: "sit", screen: true, glow: "dim", signal: "none", present: true },
  off: { pose: "away", screen: false, glow: "off", signal: "none", present: false },
  closed: { pose: "away", screen: false, glow: "off", signal: "none", present: false },
}

/** The look for a state; one this world does not know is drawn as idle, not as a crash. */
export function lookOf(state: string): StateLook {
  return Object.hasOwn(STATE_LOOK, state) ? STATE_LOOK[state as PaneState] : STATE_LOOK.idle
}

/**
 * Monitor colours, sRGB hex: the tint over the screen's picture. A session at work is neutral (cyan is the
 * hologram's); the ones that want something are their colour; a free one shows the logo, a little dimmed.
 */
export const GLOW_COLOR: Readonly<Record<StateLook["glow"], number>> = {
  cool: 0xeef0f4,
  amber: 0xffb640,
  blue: 0x6f8cff,
  red: 0xff4a4a,
  dim: 0x9aa0aa,
  off: 0x050608,
}

/** Person colours: a palette index from ADE's `look` picks one, and wraps. */
export const PERSON_COLORS: ReadonlyArray<number> = [0x3a6ea5, 0x9a4f8a, 0x4f9a6a, 0xc0793a, 0x6a6ac0, 0xb04a5a, 0x3a9aa5, 0x8a8a3a]
export const HAIR_COLORS: ReadonlyArray<number> = [0x2a1e18, 0x5a3a20, 0x1a1a22, 0x8a6a3a, 0x9a9a9a]

export const personColor = (palette: number) => PERSON_COLORS[Math.abs(Math.trunc(palette)) % PERSON_COLORS.length]
export const hairColor = (body: number) => HAIR_COLORS[Math.abs(Math.trunc(body)) % HAIR_COLORS.length]
