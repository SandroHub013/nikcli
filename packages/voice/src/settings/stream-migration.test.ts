import { describe, expect, test } from "bun:test"
import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_VOICE_SETTINGS,
  STREAM_DAILY_CAP_DEFAULT_USD,
  STREAM_DAILY_CAP_MAX_USD,
  normalizeSettings,
} from "./model"
import { STREAM_DAILY_CAP_USD } from "../asr/grok-stream"

/*
 * Version 10: live transcription over the streaming socket. A profile saved
 * before it was on OpenRouter because there was nothing else, and is moved to
 * the streaming engine without a word; one that has been through version 10
 * and chose OpenRouter stays there. The cap on the day's streamed audio is a
 * setting of its own, kept between 0 (streaming off) and five dollars.
 */

/** A profile as version 9 wrote it: everything the defaults have, minus what 10 added. */
function v9(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { streamDailyCapUsd: _cap, ...rest } = DEFAULT_VOICE_SETTINGS as unknown as Record<string, unknown>
  return { ...rest, version: 9, backend: "openrouter", openRouterApiKey: "k", ...over }
}

describe("la migrazione a v10", () => {
  test("lo streaming è la versione 10, dopo MAI", () => {
    expect(CURRENT_SETTINGS_VERSION).toBe(10)
  })

  test("un profilo v9 su OpenRouter passa allo streaming, senza messaggi", () => {
    const res = normalizeSettings(v9())
    expect(res.version).toBe(10)
    expect(res.backend).toBe("grok-stream")
    // Non è un guasto e non c'è niente da dire: né correzioni né migrazioni annunciate.
    expect(res.corrections).toEqual([])
    expect(res.migrations).toEqual([])
    // La chiave OpenRouter resta: è il ripiego, frase per frase.
    expect(res.openRouterApiKey).toBe("k")
  })

  test("senza versione, e con la versione 1, il profilo arriva allo streaming", () => {
    const { version: _version, ...noVersion } = v9()
    expect(normalizeSettings(noVersion).backend).toBe("grok-stream")
    expect(normalizeSettings(v9({ version: 1 })).backend).toBe("grok-stream")
  })

  test("chi ha già scelto OpenRouter dopo la v10 ci resta", () => {
    const res = normalizeSettings(v9({ version: 10, backend: "openrouter" }))
    expect(res.backend).toBe("openrouter")
    expect(res.version).toBe(10)
  })

  test("un profilo v10 sullo streaming ci resta", () => {
    expect(normalizeSettings(v9({ version: 10, backend: "grok-stream" })).backend).toBe("grok-stream")
  })

  test("un backend sconosciuto torna al predefinito con la correzione di sempre", () => {
    const res = normalizeSettings(v9({ version: 10, backend: "web-speech" }))
    expect(res.backend).toBe("grok-stream")
    expect(res.corrections.some((line) => line.includes("web-speech"))).toBe(true)
  })

  test("Parakeet, tolto, finisce sullo streaming e lo dice ancora una volta", () => {
    const res = normalizeSettings(v9({ backend: "parakeet" }))
    expect(res.backend).toBe("grok-stream")
    expect(res.migrations).toContain("parakeet-removed")
  })

  test("un profilo nuovo parte dallo streaming con il tetto di cinquanta centesimi", () => {
    const res = normalizeSettings(undefined)
    expect(res.backend).toBe("grok-stream")
    expect(res.streamDailyCapUsd).toBe(0.5)
    expect(DEFAULT_VOICE_SETTINGS.backend).toBe("grok-stream")
    expect(DEFAULT_VOICE_SETTINGS.streamDailyCapUsd).toBe(0.5)
  })

  test("il tetto del modello e quello del trascrittore sono lo stesso numero", () => {
    expect(STREAM_DAILY_CAP_DEFAULT_USD).toBe(STREAM_DAILY_CAP_USD)
  })
})

describe("ADE Test resta senza streaming", () => {
  test("un profilo v9 migrato in ADE Test resta su OpenRouter", () => {
    expect(normalizeSettings(v9(), { testIdentity: true }).backend).toBe("openrouter")
  })

  test("anche un profilo che dice streaming, in ADE Test, si legge OpenRouter", () => {
    expect(normalizeSettings(v9({ version: 10, backend: "grok-stream" }), { testIdentity: true }).backend).toBe(
      "openrouter",
    )
  })

  test("e un profilo vuoto, in ADE Test, parte da OpenRouter", () => {
    expect(normalizeSettings(undefined, { testIdentity: true }).backend).toBe("openrouter")
    expect(normalizeSettings({}, { testIdentity: true }).backend).toBe("openrouter")
  })

  test("fuori da ADE Test lo stesso profilo resta sullo streaming", () => {
    expect(normalizeSettings(v9({ version: 10, backend: "grok-stream" })).backend).toBe("grok-stream")
  })
})

describe("il tetto giornaliero della trascrizione in tempo reale", () => {
  const capOf = (value: unknown) => normalizeSettings(v9({ version: 10, backend: "grok-stream", streamDailyCapUsd: value }))

  test("assente è il predefinito, senza correzioni", () => {
    const res = normalizeSettings(v9({ version: 10, backend: "grok-stream" }))
    expect(res.streamDailyCapUsd).toBe(0.5)
    expect(res.corrections).toEqual([])
  })

  test("un valore dentro 0-5 si tiene com'è", () => {
    for (const value of [0.25, 1, 2.5, STREAM_DAILY_CAP_MAX_USD]) {
      const res = capOf(value)
      expect(res.streamDailyCapUsd).toBe(value)
      expect(res.corrections).toEqual([])
    }
  })

  test("zero è lo streaming spento: si tiene, non si ripara", () => {
    const res = capOf(0)
    expect(res.streamDailyCapUsd).toBe(0)
    expect(res.corrections).toEqual([])
  })

  test("sopra il massimo scende al massimo, sotto zero sale a zero, con la correzione", () => {
    const high = capOf(7)
    expect(high.streamDailyCapUsd).toBe(5)
    expect(high.corrections.length).toBe(1)
    expect(high.corrections[0]).toContain("7")
    const low = capOf(-1)
    expect(low.streamDailyCapUsd).toBe(0)
    expect(low.corrections.length).toBe(1)
  })

  test("un valore che non è un numero torna a cinquanta centesimi, con la correzione", () => {
    for (const value of ["molto", null, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      const res = capOf(value)
      expect(res.streamDailyCapUsd).toBe(0.5)
      expect(res.corrections.length).toBe(1)
    }
  })

  test("il tetto sopravvive a un secondo passaggio dal normalizzatore", () => {
    const once = capOf(1.25)
    const twice = normalizeSettings(once.settings)
    expect(twice.streamDailyCapUsd).toBe(1.25)
    expect(twice.backend).toBe("grok-stream")
    expect(twice.corrections).toEqual([])
  })
})
