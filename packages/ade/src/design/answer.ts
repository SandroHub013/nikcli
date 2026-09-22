import type { AnsweredDesignEvent } from "./log"
import type { DesignProposal } from "./state"
import { locale, t } from "../i18n"

export const USER = "utente"

export type SheetKey =
  | { readonly kind: "pick"; readonly index: number }
  | { readonly kind: "submit" }
  | { readonly kind: "need-choice" }
  | { readonly kind: "close" }
  | { readonly kind: "next" }
  | { readonly kind: "previous" }
  | { readonly kind: "expand" }

export function sheetKey(
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  variantCount: number,
  inText: boolean,
  picked: boolean,
): SheetKey | undefined {
  if (event.key === "Escape") return { kind: "close" }
  if (event.key === "Enter") {
    if (event.ctrlKey || event.metaKey) return { kind: "submit" }
    if (inText) return undefined
    return picked ? { kind: "submit" } : { kind: "need-choice" }
  }
  if (inText || event.ctrlKey || event.metaKey || event.altKey) return undefined
  if (/^[1-9]$/.test(event.key)) {
    const index = Number(event.key) - 1
    return index < variantCount ? { kind: "pick", index } : undefined
  }
  if (event.key === "ArrowRight") return { kind: "next" }
  if (event.key === "ArrowLeft") return { kind: "previous" }
  if (event.key === "f" || event.key === "F") return { kind: "expand" }
  return undefined
}

export function answerEvent(
  proposal: Pick<DesignProposal, "k" | "variants">,
  picked: number | undefined,
  note: string,
  at: Date,
): AnsweredDesignEvent | string {
  const choice = picked === undefined ? undefined : proposal.variants[picked]?.name
  const trimmed = note.trim()
  if (!choice && !trimmed) return t("design.needChoice")
  const words = [choice, trimmed].filter(Boolean).join(" — ")
  return {
    type: "risposta",
    k: proposal.k,
    at: at.toISOString(),
    by: USER,
    words,
    ...(choice ? { choice } : {}),
    ...(trimmed ? { note: trimmed } : {}),
  }
}

/**
 * «Altro giro»: not a choice, the note says what to change. Without a note
 * there is nothing for the author to do, so nothing is recorded.
 */
export function againEvent(proposal: Pick<DesignProposal, "k">, note: string, at: Date): AnsweredDesignEvent | string {
  const words = note.trim()
  if (!words) return t("design.again.needNote")
  return { type: "risposta", k: proposal.k, at: at.toISOString(), by: USER, words, again: true }
}

const MONTHS_IT = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const month = (index: number) => (locale() === "en" ? MONTHS_EN : MONTHS_IT)[index]

export function formatDay(iso: string, now: Date): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  )
  if (days === 0) return t("date.today")
  if (days === 1) return t("date.tomorrow")
  const base = `${date.getDate()} ${month(date.getMonth())}`
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`
}

export function formatMoment(ms: number, now: Date): string {
  const date = new Date(ms)
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return sameDay ? time : `${date.getDate()} ${month(date.getMonth())} ${time}`
}

export function countLabel(count: number): string {
  return t("design.count", count)
}
