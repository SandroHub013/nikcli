import { afterEach, describe, expect, test } from "bun:test"
import { isVoiceReady, voicePrerequisitesList, type VoicePrerequisitesState } from "./onboarding"
import { setLocalePreference } from "../i18n/locale"

describe("voice onboarding prerequisites", () => {
  afterEach(() => {
    setLocalePreference("it")
  })
  test("isVoiceReady returns true only when all three requirements are met", () => {
    expect(isVoiceReady({ hasKey: true, hasAgent: true, hasVoice: true })).toBe(true)
    expect(isVoiceReady({ hasKey: false, hasAgent: true, hasVoice: true })).toBe(false)
    expect(isVoiceReady({ hasKey: true, hasAgent: false, hasVoice: true })).toBe(false)
    expect(isVoiceReady({ hasKey: true, hasAgent: true, hasVoice: false })).toBe(false)
    expect(isVoiceReady({ hasKey: false, hasAgent: false, hasVoice: false })).toBe(false)
  })

  test("voicePrerequisitesList produces the 3 expected rows with appropriate actions", () => {
    setLocalePreference("it")
    const state: VoicePrerequisitesState = {
      hasKey: false,
      hasAgent: true,
      hasVoice: false,
      isVoiceDownloading: false,
    }
    const items = voicePrerequisitesList(state)
    expect(items.length).toBe(3)

    const keyItem = items.find((i) => i.id === "key")!
    expect(keyItem.done).toBe(false)
    expect(keyItem.title).toBe("Chiave OpenRouter")
    expect(keyItem.actionLabel).toBe("Imposta chiave")

    const agentItem = items.find((i) => i.id === "agent")!
    expect(agentItem.done).toBe(true)
    expect(agentItem.title).toBe("Agente (Claude Code o Codex)")
    expect(agentItem.actionLabel).toBe("Disponibile")

    const voiceItem = items.find((i) => i.id === "voice")!
    expect(voiceItem.done).toBe(false)
    expect(voiceItem.title).toBe("Voce naturale (Piper)")
    expect(voiceItem.actionLabel).toBe("Scarica voce")
    expect(voiceItem.actionDisabled).toBe(false)
  })

  test("voicePrerequisitesList disables action and shows downloading status", () => {
    setLocalePreference("it")
    const state: VoicePrerequisitesState = {
      hasKey: true,
      hasAgent: true,
      hasVoice: false,
      isVoiceDownloading: true,
    }
    const items = voicePrerequisitesList(state)
    const voiceItem = items.find((i) => i.id === "voice")!
    expect(voiceItem.done).toBe(false)
    expect(voiceItem.actionLabel).toBe("Download in corso…")
    expect(voiceItem.actionDisabled).toBe(true)
  })

  test("voicePrerequisitesList marks completed voice as installed and disabled", () => {
    setLocalePreference("it")
    const state: VoicePrerequisitesState = {
      hasKey: true,
      hasAgent: true,
      hasVoice: true,
    }
    const items = voicePrerequisitesList(state)
    const voiceItem = items.find((i) => i.id === "voice")!
    expect(voiceItem.done).toBe(true)
    expect(voiceItem.actionLabel).toBe("Installata")
    expect(voiceItem.actionDisabled).toBe(true)
  })

  test("voicePrerequisitesList translates properly in English", () => {
    setLocalePreference("en")
    const state: VoicePrerequisitesState = {
      hasKey: false,
      hasAgent: false,
      hasVoice: false,
    }
    const items = voicePrerequisitesList(state)
    expect(items[0].title).toBe("OpenRouter API Key")
    expect(items[0].actionLabel).toBe("Set API key")
    expect(items[1].title).toBe("Agent (Claude Code or Codex)")
    expect(items[1].actionLabel).toBe("Configure agent")
    expect(items[2].title).toBe("Natural voice (Piper)")
    expect(items[2].actionLabel).toBe("Download voice")
  })
})
