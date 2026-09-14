/**
 * The orb, as a control.
 *
 * The drawing is `OrbMark`, which the HUD also uses; this is the button around
 * it and the engine wiring underneath. It is the only voice control in the
 * bar: pressing it opens the microphone for whichever of the two features is
 * the default, and the two chords open the one they name — the orb then says
 * which has it, without ever turning into a microphone glyph.
 */

import { createMemo } from "solid-js"
import type { VoiceEngine } from "../engine"
import type { DialogStatus } from "../dialog/session"
import type { VoiceMode } from "../settings/model"
import { OrbMark } from "./orb-mark"
import "./voice-orb.css"

export interface VoiceOrbProps {
  /** The voice control engine instance. */
  engine: VoiceEngine
  /** Optional extra CSS class names. */
  class?: string
}

function labelFor(status: DialogStatus, isRunning: boolean, mode: VoiceMode): string {
  if (!isRunning) return "Apri il microfono"
  if (mode === "transcription") {
    return "Dettatura in corso: quello che dici finisce nel pannello (premi per chiudere)"
  }
  switch (status) {
    case "asleep":
      return "Assistente in attesa della parola di attivazione (premi per chiudere)"
    case "confirming":
      return "L'assistente attende una conferma (premi per chiudere)"
    case "executing":
      return "L'assistente sta eseguendo un comando"
    default:
      return "Assistente in ascolto (premi per chiudere)"
  }
}

/**
 * Clamped, and squared off at the bottom.
 *
 * Raw amplitude spends most of its time very near zero and spikes on
 * consonants; feeding it straight to a scale makes the orb twitch rather than
 * breathe. The ceiling stops a cough from making it a different size of
 * object. Exported because the HUD draws the same sphere from the same signal
 * and two smoothings of one number would be two orbs disagreeing.
 */
export function orbLevel(micLevel: number, running: boolean): number {
  if (!running) return 0
  return Math.min(1, Math.max(0, micLevel * 1.6))
}

export function VoiceOrb(props: VoiceOrbProps) {
  const status = () => props.engine.status()
  const isRunning = () => props.engine.isRunning()
  const mode = () => props.engine.activeMode()

  const label = createMemo(() => labelFor(status(), isRunning(), mode()))

  return (
    <button
      type="button"
      data-component="voice-orb"
      class={props.class}
      aria-label={label()}
      aria-pressed={isRunning()}
      title={label()}
      onClick={() => void props.engine.toggle()}
    >
      <OrbMark
        awake={isRunning()}
        status={status()}
        mode={mode()}
        level={orbLevel(props.engine.micLevel(), isRunning())}
      />
    </button>
  )
}
