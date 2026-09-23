/**
 * Whether a sentence said now is taken without the assistant's name (D74).
 *
 * One rule, read by two: the program, which drops a sentence that fails it
 * («Ignorata, non inizia con …»), and the orb, which lights only while it
 * holds. The orb used to read the microphone instead, and with always-on
 * listening the microphone is always open: the orb breathed while the next
 * sentence was about to be thrown away.
 *
 * Outside agent mode with the name as activation there is no name to wait
 * for. Inside it, a sentence goes through while the assistant is awake (the
 * name, the button or an answer opened a window), while a question waits for
 * its answer, while a turn is at work, or while a key is held.
 */
import type { VoiceActivation, VoiceMode } from "../settings/model"

export interface NameGateInput {
  readonly mode: VoiceMode
  readonly activation: VoiceActivation
  readonly awake: boolean
  readonly awaitingAnswer: boolean
  readonly thinking: boolean
  readonly pressed: boolean
}

export function takesWithoutName(input: NameGateInput): boolean {
  if (input.mode !== "agent" || input.activation !== "wake-word") return true
  return input.awake || input.awaitingAnswer || input.thinking || input.pressed
}
