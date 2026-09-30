/**
 * When the orb's two arcs turn and its iris breathes.
 *
 * Measured in the title bar (ade-team/results/ade-animazioni-costo.md), each arc costs about 11 % of a core while it turns, for a
 * disc of 28 px, because a turning element under a `mask` is re-composited at every frame; the breathing of the iris costs about as
 * much (A/B on the running app: an open microphone that only breathes cost as much as one that turned). So they move only while there is
 * something to show: the voice is listening, is waiting for an answer, or is carrying one out (the agent is working). An open
 * microphone that waits for the wake word, and dictation (which lets the words through untouched and says so by holding still),
 * show the eye open and nothing circulating.
 */

import type { DialogStatus } from "../dialog/session"
import type { VoiceMode } from "../settings/model"

const TURNING: readonly DialogStatus[] = ["listening", "confirming", "executing"]

export function orbSpins(awake: boolean, status: DialogStatus, mode?: VoiceMode): boolean {
  return awake && mode !== "transcription" && TURNING.includes(status)
}
