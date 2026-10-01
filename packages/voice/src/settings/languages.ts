/**
 * Supported speech recognition language resolution across backends.
 *
 * Provides language inventories and capability checks for:
 * - "openrouter": ISO-639-1 model multilingual capability surface
 */

import type { TranscriberBackend } from "../asr/select"

export interface LanguageOption {
  /** ISO-639-1 language code (e.g. 'it', 'en', 'fr'). */
  readonly code: string
  /** Human-readable localized label, presented in the target language where possible. */
  readonly label: string
}

/** Kept so the calls do not change shape: with one engine there is nothing left to choose here. */
export type AvailableLanguagesOptions = Record<string, never>

/**
 * Derives an endonym (name of the language in that language itself) using Intl.DisplayNames,
 * falling back to the English or code name if unavailable.
 */
export function formatLanguageLabel(code: string, fallbackName?: string): string {
  if (code.toLowerCase() === "auto") {
    return "Rilevamento automatico"
  }

  try {
    const displayNames = new Intl.DisplayNames([code], { type: "language" })
    const endonym = displayNames.of(code)
    if (endonym && endonym.length > 0) {
      return endonym.charAt(0).toUpperCase() + endonym.slice(1)
    }
  } catch {
    // Intl.DisplayNames may fail in legacy environments or for custom codes
  }

  if (fallbackName && fallbackName.length > 0) {
    return fallbackName.charAt(0).toUpperCase() + fallbackName.slice(1)
  }

  return code.toUpperCase()
}

/**
 * Standard ISO-639-1 languages supported by OpenRouter speech-to-text models (e.g. Whisper / MAI).
 */
const OPENROUTER_MAJOR_CODES: readonly string[] = [
  "it",
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "nl",
  "pl",
  "ru",
  "ja",
  "ko",
  "zh",
  "ar",
  "hi",
  "tr",
  "sv",
  "da",
  "fi",
  "no",
  "el",
  "cs",
  "ro",
  "uk",
  "id",
  "vi",
]

/**
 * Returns the list of supported languages for the given backend.
 *
 * Guarantees:
 * - Labels are formatted in their native endonym when supported by Intl.
 */
export function availableLanguages(
  backend: TranscriberBackend,
  options: AvailableLanguagesOptions = {},
): LanguageOption[] {
  switch (backend) {
    case "openrouter": {
      return OPENROUTER_MAJOR_CODES.map((code) => ({
        code,
        label: formatLanguageLabel(code),
      }))
    }

    default:
      return []
  }
}

/**
 * Checks whether a given language code is supported by the target backend.
 */
export function isLanguageSupported(
  backend: TranscriberBackend,
  code: string,
  options: AvailableLanguagesOptions = {},
): boolean {
  const cleanCode = code.trim().toLowerCase()
  if (!cleanCode) return false

  switch (backend) {
    case "openrouter":
      return OPENROUTER_MAJOR_CODES.includes(cleanCode) || cleanCode === "auto" || cleanCode.length === 2

    default:
      return false
  }
}
