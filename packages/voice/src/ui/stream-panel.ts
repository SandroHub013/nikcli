/**
 * What Voce › Riconoscimento shows about the streaming engine, decided here
 * and not in the `.tsx`.
 *
 * The state line says which engine is writing the sentences now and, when it
 * is not the one chosen, why: no xAI key, the cap at zero or reached, the key
 * refused, the credit gone, a pause after an error. The day's spending keeps
 * the stream apart from the rest. Plain functions, tested without Solid, like
 * `mai-panel.ts`.
 */

import { t } from "@nikcli-ai/ade/i18n"
import type { StreamState } from "../asr/grok-stream"
import type { TranscriberBackend } from "../asr/select"
import { formatSpendCost, type DaySpend } from "../settings/spend"

export interface StreamPanelInput {
  readonly backend: TranscriberBackend
  /**
   * The xAI key as the keychain shows it (`••••abcd`), `null` without one.
   * Undefined when the host cannot tell: the page then says nothing about it.
   */
  readonly xaiKey?: string | null
  readonly capUsd: number
  readonly spend: DaySpend
  /** Why the open transcriber is or is not streaming, as it last said. */
  readonly state?: StreamState
  readonly testIdentity: boolean
  readonly now: number
  /** The interface language, for the hours and the money. */
  readonly language: string
}

const localeOf = (language: string) => (language === "it" ? "it-IT" : "en-US")
const timeOf = (ms: number, language: string) =>
  new Date(ms).toLocaleTimeString(localeOf(language), { hour: "2-digit", minute: "2-digit" })

/** Whether the day's streaming has reached the cap. A cap of zero is «off», not «reached». */
export function streamCapped(input: Pick<StreamPanelInput, "capUsd" | "spend">): boolean {
  return input.capUsd > 0 && (input.spend.streamCost ?? 0) >= input.capUsd
}

/** The state line: which engine writes the sentences now, and why when it is not the chosen one. */
export function streamStatusText(input: StreamPanelInput): string {
  if (input.testIdentity) return t("vui.stream.status.test")
  if (input.backend === "openrouter") return t("vui.stream.status.batch")
  if (input.xaiKey === null) return t("vui.stream.status.noKey")
  if (input.capUsd <= 0) return t("vui.stream.status.off")
  if (streamCapped(input)) return t("vui.stream.status.cap")
  const state = input.state
  if (state?.kind === "auth") return t("vui.stream.status.auth")
  if (state?.kind === "credit" && state.until > input.now)
    return t("vui.stream.status.credit", timeOf(state.until, input.language))
  if (state?.kind === "paused" && state.until > input.now)
    return t("vui.stream.status.paused", timeOf(state.until, input.language))
  if (input.xaiKey === undefined) return t("vui.stream.status.unknownKey")
  return t("vui.stream.status.active", input.xaiKey)
}

/** «Riprova lo streaming»: for a refusal or a pause that the user may want to lift now. */
export function streamRetryShown(input: StreamPanelInput): boolean {
  if (input.testIdentity || input.backend !== "grok-stream" || input.xaiKey === null) return false
  const state = input.state
  if (state?.kind === "auth") return true
  return (state?.kind === "credit" || state?.kind === "paused") && state.until > input.now
}

/** «Oggi in tempo reale: 12 min, 0,04 $ di 0,50 $»: the stream's share of the day, against its cap. */
export function streamSpendText(input: Pick<StreamPanelInput, "spend" | "capUsd" | "language">): string {
  const minutes = new Intl.NumberFormat(localeOf(input.language), { maximumFractionDigits: 1 }).format(
    (input.spend.streamSeconds ?? 0) / 60,
  )
  const money = (value: number) => formatSpendCost(value, localeOf(input.language))
  return t("vui.stream.spend", minutes, money(input.spend.streamCost ?? 0), money(input.capUsd))
}

/** «Il resto oggi (OpenRouter): 8 richieste, 0,03 $»: transcription by batch, the planner and MAI. */
export function otherSpendText(spend: DaySpend, language: string): string {
  return t("vui.stream.spendOther", spend.calls, formatSpendCost(spend.cost, localeOf(language)))
}

/**
 * Whether listening on its own goes to the stream: Grok chosen, a key, a cap
 * not yet reached. Then every voice in the room costs the stream's rate, not
 * OpenRouter's; past the cap it is MAI-Transcribe-2 again (review S7b, B1).
 */
export function listenStreams(input: StreamPanelInput): boolean {
  return (
    !input.testIdentity &&
    input.backend === "grok-stream" &&
    input.xaiKey !== null &&
    input.capUsd > 0 &&
    !streamCapped(input)
  )
}

/**
 * The cost line beside «Sempre attivo», for the recognition that will carry it
 * (review S7, M1): the stream's hourly rate and the day's cap, with its minutes
 * and spend; otherwise OpenRouter's estimate, with its requests and spend.
 * Streaming adds a second line when OpenRouter also spent today (the batch
 * fallback, the planner, MAI).
 */
export function listenCostLines(input: StreamPanelInput): string[] {
  const money = (value: number) => formatSpendCost(value, localeOf(input.language))
  if (!listenStreams(input)) return [t("vui.listen.spend", input.spend.calls, money(input.spend.cost))]
  const minutes = new Intl.NumberFormat(localeOf(input.language), { maximumFractionDigits: 1 }).format(
    (input.spend.streamSeconds ?? 0) / 60,
  )
  const lines = [t("vui.listen.spendStream", money(input.capUsd), minutes, money(input.spend.streamCost ?? 0))]
  if (input.spend.calls > 0) lines.push(otherSpendText(input.spend, input.language))
  return lines
}
