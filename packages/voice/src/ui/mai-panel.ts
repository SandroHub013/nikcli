/**
 * What the panel shows about MAI, decided here and not in the `.tsx`.
 *
 * The block lives in the OpenRouter card of the settings, because MAI spends
 * that key. Every choice it makes — whether the one-time question appears,
 * whether «Riprova MAI» does, what the state line says, what the day's spending
 * reads — is a plain function, so it is tested without mounting Solid.
 */

import { t } from "@nikcli-ai/ade/i18n"
import type { ReplyVoice } from "../settings/model"
import { isMaiVoice, maiVoiceOfferPending } from "../settings/reply-voices"
import { formatSpendCost, type DaySpend } from "../settings/spend"
import { MAI_DAILY_CAP_USD, type MaiFailureKind } from "../tts/mai"

/**
 * The closures «Riprova MAI» is for: the ones that do not reopen by themselves
 * (401, 400/413, 402) and the two that change out of band (403, 404).
 */
const RETRYABLE: ReadonlySet<MaiFailureKind> = new Set([
  "payment",
  "unauthorized",
  "bad-request",
  "forbidden",
  "unavailable",
])

export interface MaiPanelInput {
  readonly replyVoice: ReplyVoice
  readonly replyVoiceOffer?: "accepted" | "declined"
  readonly hasKey: boolean
  readonly testIdentity: boolean
  /** Why the speaker is not asking MAI right now, as it last reported. */
  readonly blocked?: MaiFailureKind
  readonly spend: DaySpend
}

/** The one-time question: Piper/Ugo, a key, no answer yet, never in ADE Test. */
export function maiOfferShown(input: MaiPanelInput): boolean {
  return maiVoiceOfferPending({
    replyVoice: input.replyVoice,
    hasKey: input.hasKey,
    testIdentity: input.testIdentity,
    ...(input.replyVoiceOffer ? { replyVoiceOffer: input.replyVoiceOffer } : {}),
  })
}

/** Whether the day's replies have reached the cap. */
export function maiCapped(spend: DaySpend): boolean {
  return (spend.replyCost ?? 0) >= MAI_DAILY_CAP_USD
}

/** «Riprova MAI»: only for a closure a cooldown does not lift on its own. */
export function maiRetryShown(input: MaiPanelInput): boolean {
  return input.blocked !== undefined && RETRYABLE.has(input.blocked)
}

/** Why MAI is not answering, in words, or undefined when it is. */
export function maiFallbackReason(input: MaiPanelInput): string | undefined {
  if (input.blocked !== undefined && input.blocked !== "no-key" && input.blocked !== "aborted") {
    const key = `vui.mai.reason.${input.blocked}`
    return RETRYABLE.has(input.blocked) || input.blocked === "rate-limited" || input.blocked === "cap"
      ? t(key as "vui.mai.reason.payment")
      : t("vui.mai.reason.other")
  }
  if (maiCapped(input.spend)) return t("vui.mai.reason.cap")
  return undefined
}

/** The state line under the title. */
export function maiStatusText(input: MaiPanelInput): string {
  if (input.testIdentity) return t("vui.mai.status.test")
  if (!isMaiVoice(input.replyVoice)) return t("vui.mai.status.notChosen")
  if (!input.hasKey) return t("vui.mai.status.noKey")
  const reason = maiFallbackReason(input)
  return reason ? t("vui.mai.status.fallback", reason) : t("vui.mai.status.active")
}

/** «0,12 $ di 0,50 $ oggi · 8 frasi»: the replies' share of the day, against the cap. */
export function maiSpendText(spend: DaySpend, language: string): string {
  const money = (value: number) => formatSpendCost(value, language === "it" ? "it-IT" : "en-US")
  return t("vui.mai.spend", money(spend.replyCost ?? 0), money(MAI_DAILY_CAP_USD), spend.replyCalls ?? 0)
}
