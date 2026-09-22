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

/** What is picked in a card: one index, or for a `multi` question the boxes ticked. */
export type Picked = number | readonly number[] | undefined

/** A digit or a click on option `index`: picks it, or on a `multi` question ticks or unticks its box. */
export function togglePick(picked: Picked, index: number, multi: boolean): number | number[] {
  if (!multi) return index
  const boxes = Array.isArray(picked) ? picked : []
  return boxes.includes(index) ? boxes.filter((item) => item !== index) : [...boxes, index].sort((a, b) => a - b)
}

export function isPicked(picked: Picked, index: number): boolean {
  return Array.isArray(picked) ? picked.includes(index) : picked === index
}

export function hasPick(picked: Picked): boolean {
  return Array.isArray(picked) ? picked.length > 0 : picked !== undefined
}

/** The first option picked, for what shows one at a time. */
export function firstPick(picked: Picked): number | undefined {
  return Array.isArray(picked) ? picked[0] : (picked as number | undefined)
}

/**
 * Whether a plain Enter records. A single question: only a choice made in
 * this window. A `multi` one: at least one box ticked, or a note.
 */
export function enterReady(multi: boolean, picked: Picked, note: string, chosenHere: boolean): boolean {
  if (multi) return hasPick(picked) || note.trim().length > 0
  return chosenHere && hasPick(picked)
}

export function answerEvent(
  proposal: Pick<DesignProposal, "k" | "variants"> & { multi?: true },
  picked: Picked,
  note: string,
  at: Date,
): AnsweredDesignEvent | string {
  const trimmed = note.trim()
  if (proposal.multi) {
    // In the variants' order, whatever order the boxes were ticked in.
    const boxes = Array.isArray(picked) ? picked : picked === undefined ? [] : [picked as number]
    const choices = proposal.variants.filter((_, index) => boxes.includes(index)).map((variant) => variant.name)
    if (choices.length === 0 && !trimmed) return t("design.needChoice")
    const words = [choices.join(" + "), trimmed].filter(Boolean).join(" — ")
    return {
      type: "risposta",
      k: proposal.k,
      at: at.toISOString(),
      by: USER,
      words,
      ...(choices.length > 0 ? { choices } : {}),
      ...(trimmed ? { note: trimmed } : {}),
    }
  }
  const index = firstPick(picked)
  const choice = index === undefined ? undefined : proposal.variants[index]?.name
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
