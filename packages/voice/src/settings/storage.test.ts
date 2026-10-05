import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  VOICE_API_KEY_STORAGE_KEY,
  VOICE_OPENROUTER_KEY_REMOVED_STORAGE_KEY,
  VOICE_SETTINGS_STORAGE_KEY,
  clearOpenRouterKeyRemoved,
  clearVoiceSettings,
  exportVoiceSettings,
  isOpenRouterKeyRemoved,
  loadVoiceSettings,
  markOpenRouterKeyRemoved,
  readLegacyOpenRouterKey,
  clearLegacyOpenRouterKey,
  resetVoiceSettings,
  saveVoiceSettings,
} from "./storage"
import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_VOICE_SETTINGS,
  setShortcutActivationEnabledForTests,
  setWakeWordEnabledForTests,
} from "./model"
import { maiVoiceOfferPending } from "./reply-voices"

class MemoryStorage implements Storage {
  private data = new Map<string, string>()

  get length(): number {
    return this.data.size
  }

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
}

class ThrowingStorage implements Storage {
  length = 0
  clear(): void {
    throw new Error("SecurityError: Access denied")
  }
  getItem(): string | null {
    throw new Error("SecurityError: Access denied")
  }
  key(): string | null {
    throw new Error("SecurityError: Access denied")
  }
  removeItem(): void {
    throw new Error("SecurityError: Access denied")
  }
  setItem(): void {
    throw new Error("QuotaExceededError")
  }
}

describe("settings/storage", () => {
  test("loads default settings when storage is empty", () => {
    const storage = new MemoryStorage()
    const settings = loadVoiceSettings(storage)
    expect(settings.mode).toBe(DEFAULT_VOICE_SETTINGS.mode)
    expect(settings.agentChord).toBe(DEFAULT_VOICE_SETTINGS.agentChord)
  })

  test("persists and reloads modified settings through normalizeSettings", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings(
      {
        mode: "transcription",
        transcriptionSend: "auto",
        language: "en",
      },
      storage,
    )

    const raw = storage.getItem(VOICE_SETTINGS_STORAGE_KEY)
    expect(raw).not.toBeNull()

    const loaded = loadVoiceSettings(storage)
    expect(loaded.mode).toBe("transcription")
    expect(loaded.transcriptionSend).toBe("auto")
    expect(loaded.language).toBe("en")
    expect(loaded.agentChord).toBe(DEFAULT_VOICE_SETTINGS.agentChord)
  })

  /*
   * "Survives a reload" is the whole promise of a rebindable shortcut, and it
   * is the one thing that cannot be seen in the panel. A second load from the
   * same store is what a fresh window does.
   */
  test("le scorciatoie riassegnate sopravvivono al riavvio", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings({ agentChord: "mod+alt+space", transcriptionChord: "alt+shift+f9" }, storage)

    const reopened = loadVoiceSettings(storage)
    expect(reopened.agentChord).toBe("mod+alt+space")
    expect(reopened.transcriptionChord).toBe("alt+shift+f9")
    expect(reopened.corrections).toHaveLength(0)
  })

  test("una scorciatoia pericolosa già presente nel profilo viene riparata al caricamento", () => {
    const storage = new MemoryStorage()
    // Not written by the panel: the recorder refuses this. A hand-edited or
    // copied profile is the only way it gets here.
    storage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, agentChord: "k" }))

    const loaded = loadVoiceSettings(storage)
    expect(loaded.agentChord).toBe(DEFAULT_VOICE_SETTINGS.agentChord)
    expect(loaded.corrections.some((c) => c.includes("Scorciatoia"))).toBe(true)
  })

  test("gracefully recovers when storage throws (private window / security restriction)", () => {
    const throwingStore = new ThrowingStorage()

    expect(() => loadVoiceSettings(throwingStore)).not.toThrow()
    const loaded = loadVoiceSettings(throwingStore)
    expect(loaded.mode).toBe("agent")

    expect(() => saveVoiceSettings({ mode: "transcription" }, throwingStore)).not.toThrow()
    const saved = saveVoiceSettings({ mode: "transcription" }, throwingStore)
    expect(saved.mode).toBe("transcription")
    expect(saved.corrections.length).toBeGreaterThan(0)
  })

  test("clears storage and restores defaults", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings({ mode: "transcription" }, storage)
    expect(storage.getItem(VOICE_SETTINGS_STORAGE_KEY)).not.toBeNull()

    clearVoiceSettings(storage)
    expect(storage.getItem(VOICE_SETTINGS_STORAGE_KEY)).toBeNull()

    const loaded = loadVoiceSettings(storage)
    expect(loaded.mode).toBe("agent")
  })
})

/*
 * La chiave OpenRouter era un campo come gli altri dentro `voice.settings`,
 * poi una voce sua in localStorage: in chiaro nel profilo di WebView2 in tutti
 * e due i casi. Dalla S6 sta nel portachiavi del sistema, e questo file non la
 * scrive più: la legge dal vecchio posto solo perché ADE la sposti.
 */
describe("la chiave API non è più un'impostazione salvata", () => {
  test("salvare non la scrive da nessuna parte del browser", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings({ openRouterApiKey: "sk-or-segreta" }, storage)

    expect(storage.getItem(VOICE_API_KEY_STORAGE_KEY)).toBeNull()
    expect(storage.getItem(VOICE_SETTINGS_STORAGE_KEY)).not.toContain("sk-or-segreta")
    expect(storage.getItem(VOICE_SETTINGS_STORAGE_KEY)).not.toContain("openRouterApiKey")
    expect(loadVoiceSettings(storage).openRouterApiKey).toBeUndefined()
  })

  test("una chiave nel vecchio posto non torna nelle impostazioni, ma si legge per spostarla", () => {
    const storage = new MemoryStorage()
    storage.setItem(VOICE_API_KEY_STORAGE_KEY, "sk-or-vecchia")

    expect(loadVoiceSettings(storage).openRouterApiKey).toBeUndefined()
    expect(readLegacyOpenRouterKey(storage)).toBe("sk-or-vecchia")
    clearLegacyOpenRouterKey(storage)
    expect(readLegacyOpenRouterKey(storage)).toBeUndefined()
  })

  /*
   * Un profilo scritto prima della separazione ha ancora la chiave dentro il
   * blob: il primo salvataggio la toglie dal blob, e non deve perderla prima
   * che ADE l'abbia spostata nel portachiavi.
   */
  test("una chiave dentro il blob sopravvive al primo salvataggio, fuori dal blob", () => {
    const storage = new MemoryStorage()
    storage.setItem(
      VOICE_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, openRouterApiKey: "sk-or-vecchia" }),
    )

    expect(loadVoiceSettings(storage).openRouterApiKey).toBeUndefined()
    saveVoiceSettings({}, storage)
    expect(storage.getItem(VOICE_SETTINGS_STORAGE_KEY)).not.toContain("sk-or-vecchia")
    expect(readLegacyOpenRouterKey(storage)).toBe("sk-or-vecchia")
  })

  test("togliere la vecchia chiave la toglie anche da dentro il blob", () => {
    const storage = new MemoryStorage()
    storage.setItem(
      VOICE_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, language: "en", openRouterApiKey: "sk-or-vecchia" }),
    )
    clearLegacyOpenRouterKey(storage)
    expect(readLegacyOpenRouterKey(storage)).toBeUndefined()
    expect(storage.getItem(VOICE_SETTINGS_STORAGE_KEY)).not.toContain("sk-or-vecchia")
    expect(loadVoiceSettings(storage).language).toBe("en")
  })

  test("un salvataggio non tocca il segno di rimozione: lo decide chi toglie la chiave", () => {
    const storage = new MemoryStorage()
    markOpenRouterKeyRemoved(storage)
    saveVoiceSettings({ openRouterApiKey: "sk-or-nuova" }, storage)
    expect(isOpenRouterKeyRemoved(storage)).toBe(true)
    clearOpenRouterKeyRemoved(storage)
    saveVoiceSettings({ openRouterApiKey: "" }, storage)
    expect(isOpenRouterKeyRemoved(storage)).toBe(false)
  })

  test("«reset» toglie la vecchia chiave del browser, senza segnare una rimozione", () => {
    const storage = new MemoryStorage()
    storage.setItem(VOICE_API_KEY_STORAGE_KEY, "sk-or-vecchia")

    resetVoiceSettings(storage)

    expect(storage.getItem(VOICE_API_KEY_STORAGE_KEY)).toBeNull()
    expect(isOpenRouterKeyRemoved(storage)).toBe(false)
  })

  test("il segno di rimozione sopravvive a una modifica che non tocca la chiave", () => {
    const storage = new MemoryStorage()
    markOpenRouterKeyRemoved(storage)

    saveVoiceSettings({ language: "en" }, storage)

    expect(isOpenRouterKeyRemoved(storage)).toBe(true)
    clearOpenRouterKeyRemoved(storage)
    expect(isOpenRouterKeyRemoved(storage)).toBe(false)
  })

  test("l'export non può portarla fuori per distrazione", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings({ openRouterApiKey: "sk-or-segreta", language: "en" }, storage)

    const exported = exportVoiceSettings(storage)
    expect(JSON.stringify(exported)).not.toContain("sk-or-segreta")
    expect("openRouterApiKey" in exported).toBe(false)
    // E resta utile: il resto delle impostazioni c'è.
    expect(exported.language).toBe("en")
  })
})

describe("the migration to the wake word happens once", () => {
  // The wake word, on by default; set here so the block does not depend on the order it runs in.
  beforeAll(() => setWakeWordEnabledForTests(true))
  afterAll(() => setWakeWordEnabledForTests(true))
  test("a profile is written back with the new version, so the notice is not shown at every start", () => {
    const store = new MemoryStorage()
    store.setItem("voice.settings", JSON.stringify({ version: 1, activation: "toggle", mode: "agent" }))

    const first = loadVoiceSettings(store)
    expect(first.settings.activation).toBe("wake-word")
    expect(first.migrations).toEqual(["wake-word", "always-listen"])

    const second = loadVoiceSettings(store)
    expect(second.settings.activation).toBe("wake-word")
    expect(second.migrations).toEqual([])
  })

  test("a stored name is rewritten to the fixed phrase in the profile", () => {
    const store = new MemoryStorage()
    store.setItem("voice.settings", JSON.stringify({ version: 2, activation: "wake-word", wakeWord: "hei nik" }))

    expect(loadVoiceSettings(store).settings.wakeWord).toBe("nik")
    expect(JSON.parse(store.getItem("voice.settings") ?? "{}").wakeWord).toBe("nik")
    expect(loadVoiceSettings(store).migrations).toEqual([])
  })

  test("the move off the removed local engine is written back at the current version, so it is told once and listening stays off", () => {
    const store = new MemoryStorage()
    store.setItem(
      VOICE_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_VOICE_SETTINGS,
        backend: "parakeet",
        alwaysListen: true,
        activation: "wake-word",
      }),
    )
    store.setItem(VOICE_API_KEY_STORAGE_KEY, "sk-or-x")

    const first = loadVoiceSettings(store)
    expect(first.settings.backend).toBe("openrouter")
    expect(first.settings.alwaysListen).toBe(false)
    expect(first.migrations).toEqual(["parakeet-removed", "parakeet-listening-off"])

    const stored = JSON.parse(store.getItem(VOICE_SETTINGS_STORAGE_KEY) ?? "{}")
    expect(stored.backend).toBe("openrouter")
    expect(stored.alwaysListen).toBe(false)

    const second = loadVoiceSettings(store)
    expect(second.migrations).toEqual([])
    expect(second.settings.alwaysListen).toBe(false)
  })
})

describe("0.7.0: a profile saved on the wake word", () => {
  // The 0.7.0 world, kept behind the switches: the wake word off, the shortcut the way in.
  beforeAll(() => {
    setWakeWordEnabledForTests(false)
    setShortcutActivationEnabledForTests(true)
  })
  afterAll(() => {
    setWakeWordEnabledForTests(true)
    setShortcutActivationEnabledForTests(false)
  })
  test("is written back on the shortcut, and told only the first time", () => {
    const store = new MemoryStorage()
    store.setItem(
      "voice.settings",
      JSON.stringify({ version: 3, activation: "wake-word", alwaysListen: true, mode: "agent" }),
    )
    const first = loadVoiceSettings(store)
    expect(first.settings.activation).toBe("push-to-talk")
    expect(first.migrations).toEqual(["shortcut-only"])
    expect(JSON.parse(store.getItem("voice.settings") ?? "{}").activation).toBe("push-to-talk")
    expect(loadVoiceSettings(store).migrations).toEqual([])
  })
})

describe("after 0.7.0: a profile saved on the shortcut", () => {
  test("is written back listening for the name, and told only the first time", () => {
    const store = new MemoryStorage()
    store.setItem(
      "voice.settings",
      JSON.stringify({ version: 5, activation: "push-to-talk", alwaysListen: false, mode: "agent" }),
    )
    const first = loadVoiceSettings(store)
    expect(first.settings.activation).toBe("wake-word")
    expect(first.settings.alwaysListen).toBe(false)
    expect(first.migrations).toEqual(["name-only"])
    expect(JSON.parse(store.getItem("voice.settings") ?? "{}").activation).toBe("wake-word")
    expect(loadVoiceSettings(store).migrations).toEqual([])
  })
})

describe("ADE Test e la voce cloud", () => {
  test("sotto l'identità di test un profilo nuovo parte su Piper, e la domanda non compare", () => {
    const store = new MemoryStorage()
    store.setItem(VOICE_API_KEY_STORAGE_KEY, "sk-or-v1-finta")
    const loaded = loadVoiceSettings(store, { testIdentity: true })
    expect(loaded.settings.replyVoice).toBe("ugo")
    expect(loaded.settings.replyBackend).toBe("piper")
    expect(
      maiVoiceOfferPending({
        replyVoice: loaded.settings.replyVoice,
        hasKey: Boolean(loaded.settings.openRouterApiKey),
        testIdentity: true,
      }),
    ).toBe(false)
    // Fuori da ADE Test lo stesso profilo nuovo è Rosa.
    expect(loadVoiceSettings(new MemoryStorage()).settings.replyVoice).toBe("it-IT-Rosa")
  })

  test("il primo salvataggio in ADE Test non scrive Rosa sul disco", () => {
    const store = new MemoryStorage()
    const saved = saveVoiceSettings({ speakReplies: true }, store, { testIdentity: true })
    expect(saved.settings.replyVoice).toBe("ugo")
    expect(JSON.parse(store.getItem(VOICE_SETTINGS_STORAGE_KEY)!).replyVoice).toBe("ugo")
  })

  const rosaV8 = () => {
    const store = new MemoryStorage()
    const old = { ...DEFAULT_VOICE_SETTINGS, version: 8, replyVoice: "it-IT-Rosa", replyBackend: "mai" }
    store.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(old))
    return store
  }
  const onDisk = (store: Storage) => JSON.parse(store.getItem(VOICE_SETTINGS_STORAGE_KEY)!)

  test("un profilo migrato in ADE Test si legge Ugo ma resta Rosa sul disco", () => {
    const store = rosaV8()
    const loaded = loadVoiceSettings(store, { testIdentity: true })
    expect(loaded.settings.replyVoice).toBe("ugo")
    expect(onDisk(store).version).toBe(CURRENT_SETTINGS_VERSION)
    expect(onDisk(store).replyVoice).toBe("it-IT-Rosa")
    expect(onDisk(store).replyBackend).toBe("mai")
    // Fuori da ADE Test la Rosa c'è ancora.
    expect(loadVoiceSettings(store).settings.replyVoice).toBe("it-IT-Rosa")
  })

  test("un salvataggio in ADE Test non scrive Ugo sopra la Rosa salvata", () => {
    const store = rosaV8()
    const saved = saveVoiceSettings({ speakReplies: true }, store, { testIdentity: true })
    expect(saved.settings.replyVoice).toBe("ugo")
    expect(onDisk(store).replyVoice).toBe("it-IT-Rosa")
    expect(onDisk(store).speakReplies).toBe(true)
  })

  test("una Rosa scelta in ADE Test si scrive, e si legge Ugo", () => {
    const store = new MemoryStorage()
    saveVoiceSettings({ speakReplies: true }, store, { testIdentity: true })
    const saved = saveVoiceSettings({ replyVoice: "it-IT-Rosa" }, store, { testIdentity: true })
    expect(saved.settings.replyVoice).toBe("ugo")
    expect(onDisk(store).replyVoice).toBe("it-IT-Rosa")
    // Una voce locale scelta dopo prende il suo posto.
    saveVoiceSettings({ replyVoice: "paola" }, store, { testIdentity: true })
    expect(onDisk(store).replyVoice).toBe("paola")
  })

  test("un salvataggio dell'oggetto intero, come fa ADE, non scrive Ugo sopra la Rosa", () => {
    const store = rosaV8()
    const shown = loadVoiceSettings(store, { testIdentity: true }).settings
    saveVoiceSettings({ ...shown, speakReplies: true }, store, { testIdentity: true })
    expect(onDisk(store).replyVoice).toBe("it-IT-Rosa")
    expect(onDisk(store).speakReplies).toBe(true)
  })

  const streamV10 = () => {
    const store = new MemoryStorage()
    store.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, backend: "grok-stream" }))
    return store
  }

  test("ADE Test legge lo streaming come OpenRouter, ma un salvataggio intero non lo scrive sopra (T5a, B1)", () => {
    const store = streamV10()
    const shown = loadVoiceSettings(store, { testIdentity: true }).settings
    expect(shown.backend).toBe("openrouter")
    saveVoiceSettings({ ...shown, streamDailyCapUsd: 1 }, store, { testIdentity: true })
    expect(onDisk(store).backend).toBe("grok-stream")
    expect(onDisk(store).streamDailyCapUsd).toBe(1)
    // Fuori da ADE Test lo streaming c'è ancora.
    expect(loadVoiceSettings(store).settings.backend).toBe("grok-stream")
  })

  test("un profilo di prima dello streaming, migrato in ADE Test, sul disco va allo streaming come fuori", () => {
    const store = rosaV8()
    loadVoiceSettings(store, { testIdentity: true })
    expect(onDisk(store).backend).toBe("grok-stream")
  })

  test("un motore scelto in ADE Test si scrive, e si legge OpenRouter", () => {
    const store = streamV10()
    const saved = saveVoiceSettings({ backend: "openrouter" }, store, { testIdentity: true })
    expect(saved.settings.backend).toBe("openrouter")
    // OpenRouter è già quello che si legge: non è una scelta, e lo streaming resta.
    expect(onDisk(store).backend).toBe("grok-stream")
    const plain = new MemoryStorage()
    plain.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, backend: "openrouter" }))
    saveVoiceSettings({ backend: "grok-stream" }, plain, { testIdentity: true })
    expect(onDisk(plain).backend).toBe("grok-stream")
    expect(loadVoiceSettings(plain, { testIdentity: true }).settings.backend).toBe("openrouter")
  })

  test("un {} salvato con la chiave nel suo spazio è un profilo, non uno nuovo", () => {
    const store = new MemoryStorage()
    store.setItem(VOICE_SETTINGS_STORAGE_KEY, "{}")
    store.setItem(VOICE_API_KEY_STORAGE_KEY, "sk-or-v1-finta")
    expect(loadVoiceSettings(store).settings.replyVoice).toBe("ugo")
    // Senza niente salvato, con la sola chiave, è nuovo: Rosa.
    const fresh = new MemoryStorage()
    fresh.setItem(VOICE_API_KEY_STORAGE_KEY, "sk-or-v1-finta")
    expect(loadVoiceSettings(fresh).settings.replyVoice).toBe("it-IT-Rosa")
  })
})
