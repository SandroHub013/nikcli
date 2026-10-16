/**
 * Numbers, money and hours as the language of ADE writes them (D32): «12,3k» and «0,10 $» in Italian, «12.3k» and
 * «$0.10» in English, the hour in the language's own style. They used to be written with a dot and a dollar sign
 * whatever the language, and the hour in the system's.
 */

import { locale, type Locale } from "../i18n/locale"

const BCP47: Record<Locale, string> = { it: "it-IT", en: "en-US" }

function decimal(value: number, digits: number, loc: Locale, minimum = 0): string {
  return new Intl.NumberFormat(BCP47[loc], { minimumFractionDigits: minimum, maximumFractionDigits: digits }).format(value)
}

/** Tokens and the like: 950, 1,2k, 12k, 3,4M. */
export function formatCount(n: number, loc: Locale = locale()): string {
  if (n >= 1_000_000) return `${decimal(n / 1_000_000, 1, loc)}M`
  if (n >= 1_000) return `${decimal(n / 1_000, n >= 10_000 ? 0 : 1, loc)}k`
  return decimal(n, 0, loc)
}

/** Dollars of a real charge: three places under a cent, two otherwise. */
export function formatUsd(usd: number, loc: Locale = locale()): string {
  const places = usd < 0.01 ? 3 : 2
  const amount = decimal(usd, places, loc, places)
  return loc === "it" ? `${amount} $` : `$${amount}`
}

/** A figure with two places and the dollar sign, for a cap («0,10 $»). */
export function formatCap(usd: number, loc: Locale = locale()): string {
  const amount = decimal(usd, 2, loc, 2)
  return loc === "it" ? `${amount} $` : `$${amount}`
}

/** The hour of a moment, as the language writes it: 14:05 in Italian, 2:05 PM in English. */
export function formatClock(ms: number, loc: Locale = locale()): string {
  return new Date(ms).toLocaleTimeString(BCP47[loc], { hour: "2-digit", minute: "2-digit" })
}
