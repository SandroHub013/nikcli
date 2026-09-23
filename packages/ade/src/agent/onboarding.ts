/**
 * Voice onboarding prerequisites: the 3 elements needed to speak to nik.
 *
 * Checkable list showing:
 * 1. OpenRouter API key (required for fast speech recognition)
 * 2. Agent CLI: Claude Code or Codex (required for action execution)
 * 3. Natural voice: Piper neural model (required for fluent speech reply)
 */

import { t } from "../i18n"

export interface VoicePrerequisitesState {
  hasKey: boolean
  hasAgent: boolean
  hasVoice: boolean
  isVoiceDownloading?: boolean
}

export interface VoicePrerequisiteItem {
  id: "key" | "agent" | "voice"
  done: boolean
  title: string
  desc: string
  actionLabel: string
  actionDisabled?: boolean
}

/** Returns true when all voice prerequisites are met. */
export function isVoiceReady(state: VoicePrerequisitesState): boolean {
  return state.hasKey && state.hasAgent && state.hasVoice
}

/** Returns the 3 checkable prerequisite items for the onboarding display. */
export function voicePrerequisitesList(state: VoicePrerequisitesState): VoicePrerequisiteItem[] {
  return [
    {
      id: "key",
      done: state.hasKey,
      title: t("agent.onboarding.key.title"),
      desc: t("agent.onboarding.key.desc"),
      actionLabel: state.hasKey ? t("agent.onboarding.key.done") : t("agent.onboarding.key.action"),
    },
    {
      id: "agent",
      done: state.hasAgent,
      title: t("agent.onboarding.agent.title"),
      desc: t("agent.onboarding.agent.desc"),
      actionLabel: state.hasAgent ? t("agent.onboarding.agent.done") : t("agent.onboarding.agent.action"),
    },
    {
      id: "voice",
      done: state.hasVoice,
      title: t("agent.onboarding.voice.title"),
      desc: t("agent.onboarding.voice.desc"),
      actionLabel: state.hasVoice
        ? t("agent.onboarding.voice.done")
        : state.isVoiceDownloading
          ? t("agent.onboarding.voice.downloading")
          : t("agent.onboarding.voice.action"),
      actionDisabled: state.hasVoice || Boolean(state.isVoiceDownloading),
    },
  ]
}
