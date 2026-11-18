/**
 * Which language ADE speaks, as live state.
 *
 * One signal, read by `t()`: every text written as `{t("…")}` in JSX is a
 * reactive expression, so changing the language repaints the window without
 * a restart. Text that was *computed* earlier — a line already in the bell, a
 * note already in a transcript — keeps the language it was written in; it is
 * a record of what was said, not a label.
 *
 * The preference has three values, not two. "system" follows the OS and is
 * the default, so a machine set to English gets English without anyone
 * opening the settings, and a person who picks a language keeps it however
 * the OS changes.
 */
import { createSignal } from "solid-js"

export type Locale = "it" | "en"
export type LocalePreference = "system" | Locale

export const LOCALES: readonly Locale[] = ["it", "en"]
export const LOCALE_PREFERENCES: readonly LocalePreference[] = ["system", "it", "en"]

/** Where the choice is kept between launches. */
export const LOCALE_STORAGE_KEY = "ade.locale"

/**
 * The language to use when the user has not chosen, from the OS's list.
 *
 * Italian for an Italian system, English for everything else: English is the
 * language most people who do not read Italian can read, and ADE has no
 * third catalog to offer them.
 */
export function systemLocaleFrom(languages: readonly (string | undefined)[]): Locale {
  const first = languages.find((language) => typeof language === "string" && language.trim().length > 0)
  return first?.trim().toLowerCase().startsWith("it") ? "it" : "en"
}

export function parseLocalePreference(raw: unknown): LocalePreference {
  return LOCALE_PREFERENCES.find((value) => value === raw) ?? "system"
}

/** Italian, ADE's own language, when the runtime says nothing (Bun, a worker). */
function readSystemLocale(): Locale {
  if (typeof navigator === "undefined") return "it"
  const languages = [...(navigator.languages ?? []), navigator.language].filter(Boolean)
  return languages.length > 0 ? systemLocaleFrom(languages) : "it"
}

function readStoredPreference(): LocalePreference {
  try {
    return parseLocalePreference(globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY))
  } catch {
    return "system"
  }
}

const [preference, setPreferenceSignal] = createSignal<LocalePreference>(readStoredPreference())
const [detectedSystemLocale, setSystemLocale] = createSignal<Locale>(readSystemLocale())

/** What the user chose: a language, or "follow the system". */
export const localePreference = preference

/** What the OS speaks, as detected from the browser environment. */
export const systemLocale = detectedSystemLocale

/** The language in effect now. */
export function locale(): Locale {
  const chosen = preference()
  return chosen === "system" ? systemLocale() : chosen
}

/** Chooses, stores, and repaints. */
export function setLocalePreference(next: LocalePreference): void {
  setPreferenceSignal(next)
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, next)
  } catch {
    /* A profile without storage keeps the choice for this run only. */
  }
  syncDocumentLanguage()
}

/**
 * The OS language changed while ADE was open (`languagechange`).
 *
 * Only matters under "system", and then it should show at once rather than
 * at the next launch.
 */
export function refreshSystemLocale(): void {
  setSystemLocale(readSystemLocale())
  syncDocumentLanguage()
}

/** `<html lang>`, so screen readers and spell checking follow the language. */
export function syncDocumentLanguage(): void {
  if (typeof document === "undefined") return
  document.documentElement.lang = locale()
}

/** For tests: the state as if freshly started, without storage. */
export function resetLocaleForTests(next: LocalePreference = "system", system: Locale = "it"): void {
  setPreferenceSignal(next)
  setSystemLocale(system)
}

const BCP47: Record<Locale, string> = { it: "it-IT", en: "en-US" }

/**
 * The language tag `Intl` wants for a language of ADE: one table, where it was
 * written out as `locale() === "it" ? "it-IT" : "en-US"` in a dozen files.
 */
export function bcp47(language: Locale = locale()): string {
  return BCP47[language]
}

/**
 * The form of a text that agrees with a number, by the language's own plural
 * rules: «1 minuto», «2 minuti»; "1 minute", "2 minutes". A catalog passes its
 * own language, because it is read through `translate` for any language.
 */
export function plural<T>(count: number, forms: { readonly one: T; readonly other: T }, language: Locale = locale()): T {
  return new Intl.PluralRules(bcp47(language)).select(count) === "one" ? forms.one : forms.other
}
