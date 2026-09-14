import { describe, expect, test } from "bun:test"
import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_VOICE_SETTINGS,
  normalizeSettings,
} from "./model"

describe("settings/model - normalizeSettings", () => {
  test("handles null, undefined, primitive, and empty inputs without throwing", () => {
    const inputs = [null, undefined, 42, "string", true, [], {}]

    for (const input of inputs) {
      expect(() => normalizeSettings(input)).not.toThrow()
      const res = normalizeSettings(input)

      expect(res.version).toBe(CURRENT_SETTINGS_VERSION)
      expect(res.mode).toBe("agent")
      expect(res.activation).toBe("toggle")
      expect(res.transcriptionSend).toBe("manual")
      expect(res.language).toBe("it")
      expect(res.wakeWord).toBe("hei nik")
      expect(res.agentChord).toBe("mod+shift+k")
      expect(res.transcriptionChord).toBe("mod+shift+j")
      expect(res.backend).toBe("openrouter")
      expect(res.parakeetBackend).toBe("auto")

      expect(res.corrections.length).toBeGreaterThan(0)
      // Allows destructuring { settings, corrections }
      expect(res.settings.mode).toBe("agent")
    }
  })

  test("resets out-of-domain values to defaults and records Italian explanations", () => {
    const corrupted = {
      version: 1,
      mode: "telepathic",
      activation: "always-on",
      transcriptionSend: "later",
      backend: "quantum-asr",
      parakeetBackend: "cuda",
      language: "",
      wakeWord: "   ",
      agentChord: "ctrl+shift", // Missing principal key!
      transcriptionChord: "+++", // Invalid chord!
    }

    const res = normalizeSettings(corrupted)

    expect(res.mode).toBe("agent")
    expect(res.activation).toBe("toggle")
    expect(res.transcriptionSend).toBe("manual")
    expect(res.backend).toBe("openrouter")
    expect(res.parakeetBackend).toBe("auto")
    expect(res.language).toBe("it")
    expect(res.wakeWord).toBe("hei nik")
    expect(res.agentChord).toBe("mod+shift+k")
    expect(res.transcriptionChord).toBe("mod+shift+j")

    expect(res.corrections.some((c) => c.includes("Modalità"))).toBe(true)
    expect(res.corrections.some((c) => c.includes("Attivazione"))).toBe(true)
    expect(res.corrections.some((c) => c.includes("Backend"))).toBe(true)
    expect(res.corrections.some((c) => c.includes("Scorciatoia"))).toBe(true)
  })

  test("migrates legacy schema versions to CURRENT_SETTINGS_VERSION", () => {
    const legacy = {
      version: 0,
      mode: "transcription",
      activation: "push-to-talk",
      transcriptionSend: "auto",
      language: "en",
      wakeWord: "hey agent",
      agentChord: "mod+shift+k",
      transcriptionChord: "mod+shift+j",
      backend: "parakeet",
      parakeetBackend: "webgpu",
    }

    const res = normalizeSettings(legacy)

    expect(res.version).toBe(CURRENT_SETTINGS_VERSION)
    expect(res.mode).toBe("transcription")
    expect(res.activation).toBe("push-to-talk")
    expect(res.transcriptionSend).toBe("auto")
    expect(res.language).toBe("en")
    expect(res.wakeWord).toBe("hey agent")
    // A stored choice survives migration; only a missing or invalid one falls
    // back to the default, which is now the cloud engine.
    expect(res.backend).toBe("parakeet")
    expect(res.parakeetBackend).toBe("webgpu")
    expect(res.corrections.some((c) => c.includes("Migrata versione"))).toBe(true)
  })

  test("preserves valid configuration with zero corrections", () => {
    const valid = {
      version: 1,
      mode: "transcription" as const,
      activation: "wake-word" as const,
      transcriptionSend: "auto" as const,
      language: "it",
      wakeWord: "hei nik",
      agentChord: "ctrl+shift+a",
      transcriptionChord: "ctrl+shift+t",
      backend: "openrouter" as const,
      openRouterApiKey: "sk-or-test-key",
      parakeetBackend: "wasm" as const,
    }

    const res = normalizeSettings(valid)

    expect(res.mode).toBe("transcription")
    expect(res.activation).toBe("wake-word")
    expect(res.openRouterApiKey).toBe("sk-or-test-key")
    expect(res.corrections).toHaveLength(0)
  })

  /*
   * Storage is reachable without the panel. A hand-edited profile, or one
   * copied from another machine, can carry a chord the recorder would never
   * have accepted — and it would arrive holding a key the user types with.
   */
  describe("scorciatoie pericolose salvate fuori dal pannello", () => {
    test("a bare printable key is repaired to the default and explained", () => {
      const res = normalizeSettings({
        ...DEFAULT_VOICE_SETTINGS,
        agentChord: "k",
        transcriptionChord: "shift+j",
      })

      expect(res.agentChord).toBe(DEFAULT_VOICE_SETTINGS.agentChord)
      expect(res.transcriptionChord).toBe(DEFAULT_VOICE_SETTINGS.transcriptionChord)
      expect(res.corrections.some((c) => c.includes("modalità agente"))).toBe(true)
      expect(res.corrections.some((c) => c.includes("scrivere"))).toBe(true)
    })

    test("a freely chosen chord that is safe is kept exactly as written", () => {
      const res = normalizeSettings({
        ...DEFAULT_VOICE_SETTINGS,
        agentChord: "mod+alt+space",
        transcriptionChord: "alt+shift+f9",
      })

      expect(res.agentChord).toBe("mod+alt+space")
      expect(res.transcriptionChord).toBe("alt+shift+f9")
      expect(res.corrections).toHaveLength(0)
    })
  })

  /*
   * The correction list rewrites what the user said before an agent reads it,
   * so what goes in it has to be exactly what they put there — nothing
   * seeded, nothing duplicated, nothing that is not a word.
   */
  describe("custom words", () => {
    test("nothing is assumed on the user's behalf", () => {
      expect(normalizeSettings({}).customWords).toEqual([])
    })

    test("the user's spelling is kept, trimmed, and blanks dropped", () => {
      const res = normalizeSettings({ customWords: ["  opencode ", "", "   ", "Tauri"] })
      expect(res.customWords).toEqual(["opencode", "Tauri"])
      // The other fields were absent and get their own corrections; trimming
      // and dropping blanks is not itself something to report.
      expect(res.corrections.some((c) => c.toLowerCase().includes("parole"))).toBe(false)
    })

    /*
     * Two spellings of the same word would both be candidates, and the
     * transcript would flip between them depending on which scored first.
     */
    test("duplicates are removed regardless of case", () => {
      expect(normalizeSettings({ customWords: ["NikCLI", "nikcli"] }).customWords).toEqual(["NikCLI"])
    })

    test("non-textual entries are dropped and reported", () => {
      const res = normalizeSettings({ customWords: ["opencode", 42, null, { a: 1 }] })
      expect(res.customWords).toEqual(["opencode"])
      expect(res.corrections.some((c) => c.includes("non testuali"))).toBe(true)
    })

    test("a list that is not a list empties it and says so", () => {
      const res = normalizeSettings({ customWords: "opencode" })
      expect(res.customWords).toEqual([])
      expect(res.corrections.some((c) => c.includes("non valido"))).toBe(true)
    })
  })
})
