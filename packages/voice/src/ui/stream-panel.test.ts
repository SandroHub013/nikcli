import { describe, expect, test } from "bun:test"
import { t } from "@nikcli-ai/ade/i18n"
import {
  otherSpendText,
  streamCapped,
  streamRetryShown,
  streamSpendText,
  streamStatusText,
  type StreamPanelInput,
} from "./stream-panel"

const now = Date.UTC(2026, 9, 5, 10, 0)
const today = { day: "2026-10-05", calls: 0, cost: 0 }
const base: StreamPanelInput = {
  backend: "grok-stream",
  xaiKey: "••••abcd",
  capUsd: 0.5,
  spend: today,
  testIdentity: false,
  now,
  language: "it",
}
const hour = (ms: number) => new Date(ms).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })

describe("lo stato dello streaming in Riconoscimento", () => {
  test("con la chiave e niente di fermo, dice che lo streaming è attivo e con quale chiave", () => {
    expect(streamStatusText(base)).toBe(t("vui.stream.status.active", "••••abcd"))
  })

  test("scelto lo streaming senza chiave xAI, dice che trascrive MAI-Transcribe-2", () => {
    expect(streamStatusText({ ...base, xaiKey: null })).toBe(
      "Streaming: nessuna chiave xAI, trascrivo con MAI-Transcribe-2",
    )
  })

  test("scelto MAI-Transcribe-2, la chiave xAI non conta", () => {
    expect(streamStatusText({ ...base, backend: "openrouter", xaiKey: null })).toBe(t("vui.stream.status.batch"))
  })

  test("ADE Test non usa mai lo streaming, e lo dice", () => {
    expect(streamStatusText({ ...base, testIdentity: true })).toBe(t("vui.stream.status.test"))
    expect(streamRetryShown({ ...base, testIdentity: true, state: { kind: "auth" } })).toBe(false)
  })

  test("un tetto a zero è «spento», un tetto raggiunto è «fino a domani»", () => {
    expect(streamStatusText({ ...base, capUsd: 0 })).toBe(t("vui.stream.status.off"))
    expect(streamCapped({ capUsd: 0, spend: today })).toBe(false)
    const spent = { ...today, streamSeconds: 9000, streamCost: 0.5 }
    expect(streamCapped({ capUsd: 0.5, spend: spent })).toBe(true)
    expect(streamStatusText({ ...base, spend: spent })).toBe(t("vui.stream.status.cap"))
    // Alzato il tetto, torna attivo: il conto è lo stesso.
    expect(streamStatusText({ ...base, spend: spent, capUsd: 1 })).toBe(t("vui.stream.status.active", "••••abcd"))
  })

  test("chiave rifiutata, credito finito, pausa: ognuno col suo motivo e con «Riprova»", () => {
    const auth = { ...base, state: { kind: "auth" } as const }
    expect(streamStatusText(auth)).toBe(t("vui.stream.status.auth"))
    expect(streamRetryShown(auth)).toBe(true)

    const until = now + 24 * 3_600_000
    const credit = { ...base, state: { kind: "credit", until } as const }
    expect(streamStatusText(credit)).toBe(t("vui.stream.status.credit", hour(until)))
    expect(streamRetryShown(credit)).toBe(true)

    const paused = { ...base, state: { kind: "paused", until: now + 60_000 } as const }
    expect(streamStatusText(paused)).toBe(t("vui.stream.status.paused", hour(now + 60_000)))
    expect(streamRetryShown(paused)).toBe(true)
  })

  test("una pausa già finita non si dice più, e non chiede «Riprova»", () => {
    const over = { ...base, state: { kind: "paused", until: now - 1 } as const }
    expect(streamStatusText(over)).toBe(t("vui.stream.status.active", "••••abcd"))
    expect(streamRetryShown(over)).toBe(false)
    expect(streamRetryShown(base)).toBe(false)
  })

  test("un host che non sa della chiave non fa dire niente sulla chiave", () => {
    const { xaiKey: _key, ...unknown } = base
    expect(streamStatusText(unknown)).toBe(t("vui.stream.status.unknownKey"))
  })
})

describe("la spesa del giorno in Riconoscimento", () => {
  test("lo streaming col suo tetto, in minuti e dollari", () => {
    const spend = { ...today, streamSeconds: 750, streamCost: 750 * (0.2 / 3600) }
    const text = streamSpendText({ spend, capUsd: 0.5, language: "it" })
    expect(text).toContain("12,5 min")
    expect(text).toContain("0,04")
    expect(text).toContain("0,50")
  })

  test("il resto (OpenRouter) a parte: non somma lo streaming", () => {
    const spend = { ...today, calls: 8, cost: 0.03, streamSeconds: 3600, streamCost: 0.2 }
    const text = otherSpendText(spend, "it")
    expect(text).toContain("8 richieste")
    expect(text).toContain("0,03")
    expect(text).not.toContain("0,23")
  })
})
