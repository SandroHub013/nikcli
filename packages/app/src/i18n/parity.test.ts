import { describe, expect, test } from "bun:test"
import { LOCALES } from "./locales"
import { UNTRANSLATED_COUNTS, UNTRANSLATED_KEYS } from "./untranslated"
import { dict as en } from "./en"
import { dict as ar } from "./ar"
import { dict as br } from "./br"
import { dict as bs } from "./bs"
import { dict as da } from "./da"
import { dict as de } from "./de"
import { dict as es } from "./es"
import { dict as fr } from "./fr"
import { dict as ja } from "./ja"
import { dict as ko } from "./ko"
import { dict as no } from "./no"
import { dict as pl } from "./pl"
import { dict as ru } from "./ru"
import { dict as th } from "./th"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"

const dicts: Record<string, Record<string, string>> = { ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, zh, zht }
const enKeys = Object.keys(en)
const known = new Set(UNTRANSLATED_KEYS)
const locales = [...LOCALES]

// `en` is the source of truth and `language.tsx` spreads it underneath every
// locale, so an untranslated key renders in English rather than breaking. The
// backlog in untranslated.ts records what is still missing; these tests keep
// it from growing. After translating, re-run `bun run script/i18n-baseline.ts`.
describe("i18n parity", () => {
  test("every locale in LOCALES has a dictionary", () => {
    for (const locale of LOCALES) expect(Object.keys(dicts[locale] ?? {}).length).toBeGreaterThan(0)
  })

  test.each(locales)("%s defines no key that English does not", (locale) => {
    const stale = Object.keys(dicts[locale]).filter((key) => !(key in en))
    expect(stale).toEqual([])
  })

  test.each(locales)("%s is missing only keys already in the backlog", (locale) => {
    const present = new Set(Object.keys(dicts[locale]))
    const missing = enKeys.filter((key) => !present.has(key))
    // A new English key must ship with translations, or be added to the backlog
    // deliberately by re-running the baseline script.
    expect(missing.filter((key) => !known.has(key))).toEqual([])
  })

  test.each(locales)("%s translates at least as many keys as the recorded baseline", (locale) => {
    const present = new Set(Object.keys(dicts[locale]))
    const missing = enKeys.filter((key) => !present.has(key))
    expect(missing.length).toBeLessThanOrEqual(UNTRANSLATED_COUNTS[locale])
  })

  test("the backlog holds no key that every locale already translates", () => {
    const stale = UNTRANSLATED_KEYS.filter((key) => LOCALES.every((locale) => key in dicts[locale]))
    expect(stale).toEqual([])
  })

  test("keys flagged as translated are not copies of the English string", () => {
    const copied: string[] = []
    for (const locale of LOCALES) {
      for (const key of ["command.session.previous.unseen", "command.session.next.unseen"]) {
        if (dicts[locale][key] === en[key as keyof typeof en]) copied.push(`${locale}:${key}`)
      }
    }
    expect(copied).toEqual([])
  })
})
