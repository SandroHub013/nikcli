/**
 * What the agent widget says, given where the dialogue has got to.
 *
 * Kept out of the component because it is the whole of the widget's judgement
 * and none of its markup: which of six engine states the user is in, whether
 * the line on screen is their words or the interface's, and which colour the
 * pill's edge takes. All of that is decidable from four strings, and a rule
 * that can be checked without a DOM should be.
 */

import type { DialogStatus } from "../dialog/session"
import type { VoiceErrorKind } from "../effect/errors"
import type { OrbRim } from "./orb-mark"

/** How urgent the widget looks. Maps to one hairline colour, nothing more. */
export type HudTone = "armed" | "listening" | "asking" | "working" | "done"

export interface OrbRimInput {
  /** Whether the microphone is open. */
  running: boolean
  /** The engine's last failure, if it has one that has not been superseded. */
  errorKind?: VoiceErrorKind
  /** Whether the local model is still being fetched and nothing can be heard. */
  preparing: boolean
}

/**
 * Which collar the widget's orb wears.
 *
 * Three answers to one question — is this thing hearing me? — and the order is
 * the whole rule. A failure wins over everything: after a start that failed
 * the microphone is shut, so a green ring would be the widget's own state
 * contradicting itself. Of the failures, a microphone that has not been
 * granted is called out separately because it is the only one the user fixes
 * from a browser prompt rather than from settings.
 *
 * The warm-up gets no ring at all. It is neither listening nor broken, and
 * inventing a fourth colour for "wait" would spend the vocabulary on the one
 * state the pill is already spelling out in words and a percentage.
 */
export function orbRim(input: OrbRimInput): OrbRim | undefined {
  if (input.errorKind === "mic-auth") return "mic-auth"
  if (input.errorKind === "failed") return "failed"
  if (input.preparing) return undefined
  return input.running ? "listening" : undefined
}

export interface HudState {
  tone: HudTone
  /** The short state word, shown above the line. */
  label: string
  /** The line the user reads. */
  line: string
  /**
   * Whether `line` is a transcript of the user rather than the widget talking.
   * Set in italics, because a widget that quoted the user in its own voice
   * would make a misheard word look like a decision the agent had taken.
   */
  quoted: boolean
}

export interface HudInput {
  status: DialogStatus
  /** What is being heard right now, still subject to revision. */
  partial: string
  /** The last thing heard in full. */
  spoken: string
  /** The readback of a matched intent, when the parse produced one. */
  readback?: string
  /** The phrase that wakes the agent, quoted back while it sleeps. */
  wakeWord: string
}

/**
 * The agent widget's line.
 *
 * The order inside `listening`/`idle` is the point: a partial transcript wins
 * over a readback, because while new speech is arriving the readback belongs
 * to the *previous* command and showing it would report the wrong thing with
 * total confidence.
 */
export function agentHudState(input: HudInput): HudState {
  const { status, partial, spoken, readback, wakeWord } = input

  switch (status) {
    case "asleep":
      return { tone: "armed", label: "in attesa", line: `di' «${wakeWord}»`, quoted: false }

    case "confirming":
      return { tone: "asking", label: "conferma", line: readback ?? spoken, quoted: false }

    case "executing":
      return { tone: "working", label: "eseguo", line: readback ?? spoken, quoted: false }

    case "dictating":
      return { tone: "listening", label: "detto", line: partial || spoken, quoted: true }

    case "listening":
    case "idle":
      if (partial.length > 0) {
        return { tone: "listening", label: "ascolto", line: partial, quoted: true }
      }
      if (readback) {
        return { tone: "done", label: "capito", line: readback, quoted: false }
      }
      return { tone: "listening", label: "ascolto", line: "parla pure", quoted: false }
  }
}

export interface HudPreparation {
  /** How far the download has got, when the server sent a total to divide by. */
  percent?: number
}

/**
 * What the widget says before either engine is able to hear anything.
 *
 * The local model is fetched on first use, and that is hundreds of megabytes:
 * long enough that a widget which only appears once the microphone is live
 * leaves the user talking into a window that shows nothing at all. Reporting
 * the wait — with its percentage when there is one — is the difference between
 * "still coming" and "broken", and those are the two readings of an empty
 * screen.
 */
export function preparingHudState(progress: HudPreparation): HudState {
  const known = typeof progress.percent === "number" && Number.isFinite(progress.percent)
  const percent = known ? Math.max(0, Math.min(100, Math.round(progress.percent!))) : undefined
  return {
    tone: "working",
    label: "preparo",
    line: percent === undefined ? "modello vocale…" : `modello vocale · ${percent}%`,
    quoted: false,
  }
}

/**
 * Fixed silhouette for the waveform.
 *
 * One amplitude drives every bar, so without a per-bar weight the row would
 * rise and fall as a single block. These weights give it the shape of a voice
 * without claiming to be a spectrum nobody measured.
 */
export const HUD_WAVE: readonly number[] = [
  0.32, 0.58, 0.86, 1, 0.72, 0.94, 0.66, 0.4, 0.78, 0.5,
]

/**
 * Height of one waveform bar, as a percentage of the row.
 *
 * The floor is the whole point of this function. An open microphone in a quiet
 * room reports a level of nearly zero, and bars drawn straight from that
 * collapse into a row of two-pixel dots — which reads as a widget that has
 * stopped working, at exactly the moment it is working and waiting. So silence
 * keeps a low uneven silhouette, and the level fills the range above it.
 */
export function waveBarHeight(weight: number, level: number, running: boolean): number {
  if (!running) return 20 + weight * 16
  // The weight is paid twice: once into the floor, so a silent room still has
  // a shape rather than a ruled line, and once into the part the level drives.
  return 18 + weight * 10 + Math.min(level * 2.2, 1) * weight * 72
}
