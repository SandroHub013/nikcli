import * as i18n from "@solid-primitives/i18n"
import { createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@nikcli-ai/ui/context"
import { Persist, persisted } from "@/utils/persist"
import { dict as en } from "@/i18n/en"
import { LOCALES as TRANSLATED_LOCALES, type Locale as TranslatedLocale } from "@/i18n/locales"
import { dict as uiEn } from "@nikcli-ai/ui/i18n/en"

/**
 * Derived from the shipped list rather than repeated.
 *
 * There were two of these — this one and `i18n/locales.ts` — with no import
 * between them. They happened to agree, but a locale added to one was invisible
 * to the other, so the parity tests would have kept passing over a dictionary
 * nobody could select.
 */
export type Locale = "en" | TranslatedLocale

const LOCALES: readonly Locale[] = ["en", ...TRANSLATED_LOCALES]

type RawDictionary = typeof en & typeof uiEn
type Dictionary = i18n.Flatten<RawDictionary>


/**
 * The 15 non-English dictionaries are ~470 kB of the entry chunk and a session
 * uses exactly one, so each is fetched on demand. English stays static: it is
 * the base every locale is spread over, so it must be there on first paint.
 *
 * Each entry pairs the app and UI dictionary for a locale, which lets the
 * bundler put both in a single per-locale chunk.
 */
const LOADERS: Record<Exclude<Locale, "en">, () => Promise<Partial<RawDictionary>>> = {
  zh: async () => ({ ...(await import("@/i18n/zh")).dict, ...(await import("@nikcli-ai/ui/i18n/zh")).dict }),
  zht: async () => ({ ...(await import("@/i18n/zht")).dict, ...(await import("@nikcli-ai/ui/i18n/zht")).dict }),
  ko: async () => ({ ...(await import("@/i18n/ko")).dict, ...(await import("@nikcli-ai/ui/i18n/ko")).dict }),
  de: async () => ({ ...(await import("@/i18n/de")).dict, ...(await import("@nikcli-ai/ui/i18n/de")).dict }),
  es: async () => ({ ...(await import("@/i18n/es")).dict, ...(await import("@nikcli-ai/ui/i18n/es")).dict }),
  fr: async () => ({ ...(await import("@/i18n/fr")).dict, ...(await import("@nikcli-ai/ui/i18n/fr")).dict }),
  da: async () => ({ ...(await import("@/i18n/da")).dict, ...(await import("@nikcli-ai/ui/i18n/da")).dict }),
  ja: async () => ({ ...(await import("@/i18n/ja")).dict, ...(await import("@nikcli-ai/ui/i18n/ja")).dict }),
  pl: async () => ({ ...(await import("@/i18n/pl")).dict, ...(await import("@nikcli-ai/ui/i18n/pl")).dict }),
  ru: async () => ({ ...(await import("@/i18n/ru")).dict, ...(await import("@nikcli-ai/ui/i18n/ru")).dict }),
  ar: async () => ({ ...(await import("@/i18n/ar")).dict, ...(await import("@nikcli-ai/ui/i18n/ar")).dict }),
  no: async () => ({ ...(await import("@/i18n/no")).dict, ...(await import("@nikcli-ai/ui/i18n/no")).dict }),
  br: async () => ({ ...(await import("@/i18n/br")).dict, ...(await import("@nikcli-ai/ui/i18n/br")).dict }),
  th: async () => ({ ...(await import("@/i18n/th")).dict, ...(await import("@nikcli-ai/ui/i18n/th")).dict }),
  bs: async () => ({ ...(await import("@/i18n/bs")).dict, ...(await import("@nikcli-ai/ui/i18n/bs")).dict }),
}

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) {
      if (language.toLowerCase().includes("hant")) return "zht"
      return "zh"
    }
    if (language.toLowerCase().startsWith("ko")) return "ko"
    if (language.toLowerCase().startsWith("de")) return "de"
    if (language.toLowerCase().startsWith("es")) return "es"
    if (language.toLowerCase().startsWith("fr")) return "fr"
    if (language.toLowerCase().startsWith("da")) return "da"
    if (language.toLowerCase().startsWith("ja")) return "ja"
    if (language.toLowerCase().startsWith("pl")) return "pl"
    if (language.toLowerCase().startsWith("ru")) return "ru"
    if (language.toLowerCase().startsWith("ar")) return "ar"
    if (
      language.toLowerCase().startsWith("no") ||
      language.toLowerCase().startsWith("nb") ||
      language.toLowerCase().startsWith("nn")
    )
      return "no"
    if (language.toLowerCase().startsWith("pt")) return "br"
    if (language.toLowerCase().startsWith("th")) return "th"
    if (language.toLowerCase().startsWith("bs")) return "bs"
  }

  return "en"
}

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  init: () => {
    const [store, setStore, _, ready] = persisted(
      Persist.global("language", ["language.v1"]),
      createStore({
        locale: detectLocale() as Locale,
      }),
    )

    const locale = createMemo<Locale>(() => {
      if (store.locale === "zh") return "zh"
      if (store.locale === "zht") return "zht"
      if (store.locale === "ko") return "ko"
      if (store.locale === "de") return "de"
      if (store.locale === "es") return "es"
      if (store.locale === "fr") return "fr"
      if (store.locale === "da") return "da"
      if (store.locale === "ja") return "ja"
      if (store.locale === "pl") return "pl"
      if (store.locale === "ru") return "ru"
      if (store.locale === "ar") return "ar"
      if (store.locale === "no") return "no"
      if (store.locale === "br") return "br"
      if (store.locale === "th") return "th"
      if (store.locale === "bs") return "bs"
      return "en"
    })

    createEffect(() => {
      const current = locale()
      if (store.locale === current) return
      setStore("locale", current)
    })

    const base = i18n.flatten({ ...en, ...uiEn })
    // A plain signal, not a store: these dictionaries are ~900 keys each and
    // wrapping them in a deep reactive proxy would cost on every lookup for no
    // benefit — an entry is written once and never mutated in place.
    const [translations, setTranslations] = createSignal<Record<string, Dictionary>>({})

    createEffect(() => {
      const current = locale()
      if (current === "en" || translations()[current]) return
      LOADERS[current]()
        .then((loaded) =>
          setTranslations((previous) => ({ ...previous, [current]: i18n.flatten(loaded) as Dictionary })),
        )
        // A locale chunk that fails to load leaves the English base in place,
        // which is what an untranslated key renders as anyway.
        .catch(() => {})
    })

    const dict = createMemo<Dictionary>(() => {
      const loaded = locale() === "en" ? undefined : translations()[locale()]
      return loaded ? { ...base, ...loaded } : base
    })

    const t = i18n.translator(dict, i18n.resolveTemplate)

    const labelKey: Record<Locale, keyof Dictionary> = {
      en: "language.en",
      zh: "language.zh",
      zht: "language.zht",
      ko: "language.ko",
      de: "language.de",
      es: "language.es",
      fr: "language.fr",
      da: "language.da",
      ja: "language.ja",
      pl: "language.pl",
      ru: "language.ru",
      ar: "language.ar",
      no: "language.no",
      br: "language.br",
      th: "language.th",
      bs: "language.bs",
    }

    const label = (value: Locale) => t(labelKey[value])

    createEffect(() => {
      if (typeof document !== "object") return
      document.documentElement.lang = locale()
    })

    return {
      ready,
      locale,
      locales: LOCALES,
      label,
      t,
      setLocale(next: Locale) {
        setStore("locale", next)
      },
    }
  },
})
