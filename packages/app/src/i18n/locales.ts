/** Every locale shipped besides `en`, which is the source of truth. */
export const LOCALES = [
  "ar",
  "br",
  "bs",
  "da",
  "de",
  "es",
  "fr",
  "ja",
  "ko",
  "no",
  "pl",
  "ru",
  "th",
  "zh",
  "zht",
] as const

export type Locale = (typeof LOCALES)[number]
