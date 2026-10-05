import { describe, expect, test } from "bun:test"
import { CURRENT_SETTINGS_VERSION, DEFAULT_VOICE_SETTINGS, normalizeSettings, type VoiceSettings } from "./model"
import { MAI_VOICES, acceptMaiVoice, isMaiVoice, maiReplyVoice, maiVoiceOfferPending } from "./reply-voices"

function v8(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...DEFAULT_VOICE_SETTINGS,
    version: 8,
    replyVoice: "ugo",
    replyBackend: "piper",
    ...over,
  }
}

describe("la migrazione a v9", () => {
  test("MAI è la versione 9, dopo Kokoro", () => {
    expect(CURRENT_SETTINGS_VERSION).toBe(9)
  })

  test("un profilo esistente resta sulla voce che aveva", () => {
    for (const voice of ["ugo", "paola", "lessac", "af_heart", "system"] as const) {
      const res = normalizeSettings(v8({ replyVoice: voice }))
      expect(res.replyVoice).toBe(voice)
      expect(res.version).toBe(9)
      expect(res.replyVoiceOffer).toBeUndefined()
    }
  })

  test("un profilo nuovo parte su Rosa, e ADE Test resta su Piper", () => {
    const fresh = normalizeSettings(null)
    expect(fresh.replyBackend).toBe("mai")
    expect(fresh.replyVoice).toBe("it-IT-Rosa")
    expect(fresh.ttsLocale).toBe("it-IT")
    const test = normalizeSettings(null, { testIdentity: true })
    expect(test.replyBackend).toBe("piper")
    expect(test.replyVoice).toBe("ugo")
  })

  test("un profilo che aveva già una voce la tiene", () => {
    const res = normalizeSettings({ replyVoice: "paola" })
    expect(res.replyVoice).toBe("paola")
    expect(res.replyBackend).toBe("piper")
  })

  test("la migrazione è idempotente", () => {
    const once = normalizeSettings(v8({ replyVoice: "paola" }))
    const twice = normalizeSettings({ ...once, version: 8 })
    expect(twice.settings).toEqual(once.settings)
  })

  test("una voce MAI sconosciuta torna a Rosa", () => {
    const res = normalizeSettings(v8({ replyVoice: "it-IT-Nessuno", replyBackend: "mai" }))
    expect(res.replyVoice).toBe("it-IT-Rosa")
    expect(res.replyBackend).toBe("mai")
  })

  test("Rosa su un altro backend torna su MAI, che è il suo", () => {
    const res = normalizeSettings(v8({ replyVoice: "it-IT-Rosa", replyBackend: "piper" }))
    expect(res.replyBackend).toBe("mai")
    expect(res.replyVoice).toBe("it-IT-Rosa")
    expect(res.corrections).toEqual([])
  })

  test("la risposta alla domanda si conserva, e un valore inventato si perde", () => {
    expect(normalizeSettings(v8({ replyVoiceOffer: "declined" })).replyVoiceOffer).toBe("declined")
    expect(normalizeSettings(v8({ replyVoiceOffer: "forse" })).replyVoiceOffer).toBeUndefined()
  })
})

describe("la domanda una volta sola", () => {
  const pending = {
    replyVoice: "ugo" as const,
    hasKey: true,
    testIdentity: false,
  }

  test("appare solo su Piper/Ugo, con la chiave, e mai in ADE Test", () => {
    expect(maiVoiceOfferPending(pending)).toBe(true)
    expect(maiVoiceOfferPending({ ...pending, hasKey: false })).toBe(false)
    expect(maiVoiceOfferPending({ ...pending, testIdentity: true })).toBe(false)
    expect(maiVoiceOfferPending({ ...pending, replyVoice: "paola" })).toBe(false)
  })

  test("una risposta data, qualunque sia, non la ripropone", () => {
    expect(maiVoiceOfferPending({ ...pending, replyVoiceOffer: "accepted" })).toBe(false)
    expect(maiVoiceOfferPending({ ...pending, replyVoiceOffer: "declined" })).toBe(false)
  })

  test("«Usa» scrive Rosa e chiude la domanda", () => {
    const accepted = acceptMaiVoice()
    expect(accepted).toEqual({
      replyVoice: "it-IT-Rosa",
      replyBackend: "mai",
      replyVoiceOffer: "accepted",
    })
    const saved = normalizeSettings({ ...DEFAULT_VOICE_SETTINGS, ...accepted })
    expect(saved.replyVoice).toBe("it-IT-Rosa")
    expect(
      maiVoiceOfferPending({
        ...pending,
        replyVoiceOffer: saved.replyVoiceOffer,
      }),
    ).toBe(false)
  })
})

describe("MAI solo in italiano, frase per frase", () => {
  const rosa = { chosen: "it-IT-Rosa" as const, local: "af_heart" as const }

  test("il testo decide, e se non decide decide l'interfaccia", () => {
    expect(maiReplyVoice({ ...rosa, text: "Ciao, come va oggi?", ui: "en" })).toBe("it-IT-Rosa")
    expect(maiReplyVoice({ ...rosa, text: "Hello, how are you today?", ui: "it" })).toBe("af_heart")
    expect(maiReplyVoice({ ...rosa, text: "3.", ui: "it" })).toBe("it-IT-Rosa")
    expect(maiReplyVoice({ ...rosa, text: "3.", ui: "en" })).toBe("af_heart")
  })

  test("senza una voce locale ricordata, la risposta inglese va a Ugo", () => {
    expect(
      maiReplyVoice({
        chosen: "it-IT-Luca",
        text: "The tests passed.",
        ui: "it",
      }),
    ).toBe("ugo")
  })

  test("il catalogo è le quattro voci italiane, e nient'altro", () => {
    expect(MAI_VOICES.map((voice) => voice.id)).toEqual(["it-IT-Grant", "it-IT-Harper", "it-IT-Luca", "it-IT-Rosa"])
    for (const voice of MAI_VOICES) {
      expect(isMaiVoice(voice.id)).toBe(true)
      expect(voice.wire).toBe(`${voice.id}:MAI-Voice-2.1-Flash`)
    }
  })

  test("il tipo non accetta una quinta voce", () => {
    const settings: VoiceSettings = {
      ...DEFAULT_VOICE_SETTINGS,
      replyVoice: "it-IT-Rosa",
      replyBackend: "mai",
    }
    expect(settings.replyBackend).toBe("mai")
  })
})
