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

/**
 * Whether the dialogue is waiting for an answer the room may give without the
 * name: a question the user started (a destructive command, a plan, a note
 * the voice agent wants to send) or a disambiguation.
 *
 * Not an agent's permission (V1-bis, ALTO 5). The user did not start it: in
 * wake-word mode it arrives while nobody is talking to the assistant, and an
 * open gate let the «va bene» of a television grant it for 30 s. Its answer
 * starts with the name, like any sentence at rest.
 */
export function answersWithoutName(
  state: { readonly status: string; readonly pendingAction?: { readonly isPermission?: boolean } },
  disambiguating: boolean,
): boolean {
  if (disambiguating) return true
  return state.status === "confirming" && state.pendingAction?.isPermission !== true
}
