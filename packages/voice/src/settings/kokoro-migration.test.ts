import { describe, expect, test } from "bun:test"
import { CURRENT_SETTINGS_VERSION, DEFAULT_VOICE_SETTINGS, normalizeSettings, type VoiceSettings } from "./model"
import { isKokoroVoice, KOKORO_VOICES, speakingReplyVoice } from "./reply-voices"

/**
 * A version 7 profile: what every profile on disk looks like before Kokoro —
 * whole, so that a correction in a test is the one being looked at and not the
 * eight that a half-written object earns on the way in, and without the two
 * fields version 8 adds, because a v7 profile has never heard of them.
 */
function v7(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { version, replyBackend, ttsLocale, ...rest } = DEFAULT_VOICE_SETTINGS
  return { ...rest, version: 7, replyVoice: "ugo", language: "it", ...over }
}

/**
 * A whole profile, so that a correction in a test is the one being looked at and
 * not the eight that a half-written object earns on the way in.
 */
function v8(over: Partial<VoiceSettings> = {}): Record<string, unknown> {
  return {
    ...DEFAULT_VOICE_SETTINGS,
    version: CURRENT_SETTINGS_VERSION,
    ...over,
  }
}

describe("la migrazione a v8", () => {
  test("Kokoro è la versione 8, e chi arriva dopo aggiunge solo il suo passo", () => {
    // MAI è arrivato secondo e ha preso la 9: questo passo resta dov'era.
    expect(CURRENT_SETTINGS_VERSION).toBeGreaterThanOrEqual(8)
  })

  test("un profilo arriva su Piper, e non cambia niente di come parlava", () => {
    const res = normalizeSettings(v7({ replyVoice: "ugo" }))
    expect(res.replyVoice).toBe("ugo")
    expect(res.replyBackend).toBe("piper")
    expect(res.ttsLocale).toBe("it-IT")
    // Niente correzioni: un profilo che non sapeva di Kokoro non ha fatto
    // niente di sbagliato.
    expect(res.corrections).toEqual([])
  })

  test("la lingua viene dalla voce che il profilo aveva", () => {
    expect(normalizeSettings(v7({ replyVoice: "lessac" })).ttsLocale).toBe("en-US")
    expect(normalizeSettings(v7({ replyVoice: "paola" })).ttsLocale).toBe("it-IT")
    // La voce di sistema parla come la finestra: l'unica traccia è la lingua
    // che il profilo aveva registrato per il riconoscimento.
    expect(normalizeSettings(v7({ replyVoice: "system", language: "en" })).ttsLocale).toBe("en-US")
    expect(normalizeSettings(v7({ replyVoice: "system", language: "it" })).ttsLocale).toBe("it-IT")
    expect(normalizeSettings(v7({ replyVoice: "system", language: "de" })).ttsLocale).toBe("it-IT")
  })

  test("la voce di sistema resta sulla voce di sistema, non su un backend", () => {
    const res = normalizeSettings(v7({ replyVoice: "system" }))
    expect(res.replyBackend).toBe("system")
    expect(res.replyVoice).toBe("system")
  })

  test("un profilo senza versione prende la 8, e non perde la lingua della sua voce", () => {
    const { version, replyBackend, ttsLocale, ...rest } = DEFAULT_VOICE_SETTINGS
    const res = normalizeSettings({ ...rest, replyVoice: "lessac" })
    expect(res.version).toBe(CURRENT_SETTINGS_VERSION)
    expect(res.replyBackend).toBe("piper")
    // Un profilo senza versione è più vecchio di ogni versione, e arriva qui
    // per la strada senza numero: senza il passo della 8 avrebbe tenuto la
    // voce e perso la lingua in cui era.
    expect(res.ttsLocale).toBe("en-US")
  })

  test("la migrazione è idempotente: due volte dicono la stessa cosa", () => {
    const once = normalizeSettings(v7({ replyVoice: "lessac" }))
    const twice = normalizeSettings({ ...once, version: 7 })
    expect(twice.settings).toEqual(once.settings)
  })
})

describe("la coppia voce e backend", () => {
  test("un id Kokoro sul backend Piper tiene l'id e corregge il backend", () => {
    // Vince l'id, che è quello che l'utente ha scelto e quello che il pannello
    // nomina: il backend è la parte repairsibile della coppia. Il testo che
    // prima diceva il contrario diceva che l'id non viene accettato, e il test
    // lo accettava.
    const res = normalizeSettings(v8({ replyVoice: "af_heart", replyBackend: "piper", ttsLocale: "en-US" }))
    expect(res.replyBackend).toBe("kokoro")
    expect(res.replyVoice).toBe("af_heart")
    expect(res.corrections.length).toBeGreaterThan(0)
  })

  test("una voce di Piper con il backend Kokoro torna su Piper", () => {
    const res = normalizeSettings(v8({ replyVoice: "paola", replyBackend: "kokoro", ttsLocale: "it-IT" }))
    expect(res.replyBackend).toBe("piper")
    expect(res.replyVoice).toBe("paola")
    expect(res.corrections.length).toBeGreaterThan(0)
  })

  test("una coppia già giusta non dice niente", () => {
    for (const voice of KOKORO_VOICES) {
      const res = normalizeSettings(
        v8({
          replyVoice: voice.id,
          replyBackend: "kokoro",
          ttsLocale: voice.locale,
        }),
      )
      expect(res.corrections).toEqual([])
      expect(res.replyVoice).toBe(voice.id)
    }
  })

  test("un id che non esiste torna alla voce che c'è", () => {
    const res = normalizeSettings(
      v8({
        replyVoice: "if_sara" as VoiceSettings["replyVoice"],
        replyBackend: "kokoro",
        ttsLocale: "it-IT",
      }),
    )
    expect(res.replyVoice).toBe("it-IT-Rosa")
    expect(res.replyBackend).toBe("mai")
    expect(res.corrections.length).toBeGreaterThan(0)
  })
})

describe("Kokoro con una lingua che non può parlare", () => {
  test("la scelta dell'utente resta sul disco, e la correzione sparisce con lei", () => {
    const res = normalizeSettings(
      v8({
        replyVoice: "af_heart",
        replyBackend: "kokoro",
        ttsLocale: "it-IT",
      }),
    )
    // Niente viene riscritto: la voce che parla è decisa per ogni risposta, e
    // un profilo che ha scelto Kokoro resta su Kokoro anche se la finestra è
    // italiana. Il giorno in cui una risposta è in inglese, parla da sola.
    expect(res.replyVoice).toBe("af_heart")
    expect(res.replyBackend).toBe("kokoro")
    expect(isKokoroVoice(res.replyVoice)).toBe(true)
    // E non c'è una correzione da mostrare: non è successo niente al profilo.
    expect(res.corrections).toEqual([])
    expect(res.migrations).toEqual([])
  })

  test("non ripete: due caricamenti dello stesso profilo dicono la stessa cosa", () => {
    // Il banner che si ripeteva a ogni avvio veniva da qui: la riscrittura non
    // cambiava la versione, e il risparmio del profilo è legato alla versione.
    const stored = v8({
      replyVoice: "am_fenrir",
      replyBackend: "kokoro",
      ttsLocale: "it-IT",
    })
    const first = normalizeSettings(stored)
    const second = normalizeSettings({ ...first.settings })
    expect(second.corrections).toEqual(first.corrections)
    expect(second.settings.replyVoice).toBe("am_fenrir")
  })

  test("e la lingua in cui legge è comunque quella della risposta", () => {
    // Il rimedio non sparisce con la migrazione: è nella voce che parla, che è
    // `speakingReplyVoice` e non il profilo. Il secondo argomento è la lingua
    // che il testo della risposta dice, quindi lo stesso profilo legge in Ugo su
    // una risposta italiana e in Kokoro su una inglese.
    const res = normalizeSettings(
      v8({
        replyVoice: "am_fenrir",
        replyBackend: "kokoro",
        ttsLocale: "it-IT",
      }),
    )
    expect(speakingReplyVoice(res.replyVoice, "it-IT", "it")).toBe("ugo")
    expect(speakingReplyVoice(res.replyVoice, "en-US", "it")).toBe("am_fenrir")
  })

  test("una lingua che non è nell'elenco non viene passata al runtime", () => {
    const res = normalizeSettings(
      v8({
        replyVoice: "af_heart",
        replyBackend: "kokoro",
        ttsLocale: "en-GB-x" as VoiceSettings["ttsLocale"],
      }),
    )
    expect(["it-IT", "en-US", "en-GB"]).toContain(res.ttsLocale)
    expect(res.corrections.length).toBeGreaterThan(0)
  })
})

describe("un profilo nuovo", () => {
  test("parte su Rosa, che è la voce cloud", () => {
    const res = normalizeSettings(undefined)
    expect(res.replyVoice).toBe("it-IT-Rosa")
    expect(res.replyBackend).toBe("mai")
    expect(res.ttsLocale).toBe("it-IT")
  })

  test("nessun profilo viene portato su Kokoro da solo", () => {
    // Kokoro è una scelta esplicita: 219 MB non arrivano perché è passato del
    // tempo, e perché un profilo è stato toccato.
    for (const over of [{}, { replyVoice: "lessac" }, { replyVoice: "system" }]) {
      const res = normalizeSettings(v7(over))
      expect(isKokoroVoice(res.replyVoice)).toBe(false)
    }
  })

  test("i valori di default sono una coppia che può parlare", () => {
    const { replyVoice, replyBackend, ttsLocale }: Pick<VoiceSettings, "replyVoice" | "replyBackend" | "ttsLocale"> =
      normalizeSettings(undefined).settings
    expect(replyBackend).toBe("mai")
    expect(ttsLocale).toBe("it-IT")
    expect(replyVoice).toBe("it-IT-Rosa")
  })
})
