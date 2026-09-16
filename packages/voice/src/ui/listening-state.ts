/**
 * What the always-on indicator says, and what pressing it does.
 *
 * An open microphone nobody pressed has to be visible for as long as it is
 * open: that is the condition for opening it by itself. The indicator is also
 * the switch — the orb beside it calls the assistant instead of closing it.
 */

import type { VoiceMode, VoiceSettings } from "../settings/model"

export type ListeningState =
  | { kind: "hidden" }
  | { kind: "listening"; text: string; title: string }
  | { kind: "paused"; text: string; title: string }

export function listeningState(input: {
  settings: Pick<VoiceSettings, "alwaysListen" | "activation" | "wakeWord">
  running: boolean
  mode: VoiceMode
  paused: boolean
}): ListeningState {
  const { settings } = input
  if (!settings.alwaysListen || settings.activation !== "wake-word") return { kind: "hidden" }
  if (input.running && input.mode === "agent") {
    return {
      kind: "listening",
      text: `In ascolto · «${settings.wakeWord}»`,
      title: `Il microfono è aperto e aspetta «${settings.wakeWord}». Premi per smettere di ascoltare.`,
    }
  }
  if (input.paused) {
    return {
      kind: "paused",
      text: "Ascolto in pausa",
      title: "In pausa dopo dieci minuti senza sentire il nome. Premi per riprendere ad ascoltare.",
    }
  }
  return { kind: "hidden" }
}
