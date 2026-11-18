import { afterEach, describe, expect, test } from "bun:test"
import { createRenderEffect, createRoot } from "solid-js"
import {
  LOCALE_STORAGE_KEY,
  bcp47,
  plural,
  locale,
  localePreference,
  parseLocalePreference,
  resetLocaleForTests,
  setLocalePreference,
  systemLocale,
  systemLocaleFrom,
  t,
  translate,
} from "./index"

afterEach(() => {
  resetLocaleForTests()
  localStorage.removeItem(LOCALE_STORAGE_KEY)
})

describe("the system language", () => {
  test("Italian for an Italian system, English for anything else", () => {
    expect(systemLocaleFrom(["it-IT"])).toBe("it")
    expect(systemLocaleFrom(["it"])).toBe("it")
    expect(systemLocaleFrom(["IT-ch"])).toBe("it")
    expect(systemLocaleFrom(["en-US", "it-IT"])).toBe("en")
    expect(systemLocaleFrom(["de-DE"])).toBe("en")
    expect(systemLocaleFrom(["", undefined, "it-IT"])).toBe("it")
    expect(systemLocaleFrom([])).toBe("en")
  })
})

describe("the preference", () => {
  test("anything unknown in storage reads as System", () => {
    expect(parseLocalePreference("en")).toBe("en")
    expect(parseLocalePreference("it")).toBe("it")
    expect(parseLocalePreference("system")).toBe("system")
    expect(parseLocalePreference("fr")).toBe("system")
    expect(parseLocalePreference(null)).toBe("system")
  })

  test("System follows the machine, a choice overrides it, and the choice is stored", () => {
    resetLocaleForTests("system", "en")
    expect(systemLocale()).toBe("en")
    expect(locale()).toBe("en")
    setLocalePreference("it")
    expect(locale()).toBe("it")
    expect(localePreference()).toBe("it")
    expect(systemLocale()).toBe("en")
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("it")
    expect(document.documentElement.lang).toBe("it")
    setLocalePreference("system")
    expect(locale()).toBe("en")
    expect(systemLocale()).toBe("en")
    expect(document.documentElement.lang).toBe("en")
  })
})

describe("t()", () => {
  test("fills in values in either language", () => {
    expect(translate("it", "settings.language.systemNow", "Italiano")).toBe("Sistema (Italiano)")
    expect(translate("en", "settings.language.systemNow", "English")).toBe("System (English)")
  })

  test("a mounted text changes language without being mounted again", () => {
    resetLocaleForTests("it")
    const host = document.createElement("div")
    let runs = 0
    const dispose = createRoot((dispose) => {
      const title = document.createElement("h3")
      // What `<h3>{t("…")}</h3>` compiles to: one render effect per text.
      createRenderEffect(() => {
        runs++
        title.textContent = t("settings.tab.language")
      })
      host.append(title)
      return dispose
    })
    const node = host.firstChild
    expect(host.textContent).toBe("Lingua dell'interfaccia")
    setLocalePreference("en")
    expect(host.textContent).toBe("Interface language")
    expect(host.firstChild).toBe(node)
    setLocalePreference("it")
    expect(host.textContent).toBe("Lingua dell'interfaccia")
    expect(runs).toBe(3)
    dispose()
  })
})

describe("one language tag and one plural rule (UX-26)", () => {
  test("bcp47 names the tag Intl wants, for the language asked or the current one", () => {
    expect(bcp47("it")).toBe("it-IT")
    expect(bcp47("en")).toBe("en-US")
    resetLocaleForTests("en")
    expect(bcp47()).toBe("en-US")
    resetLocaleForTests("it")
    expect(bcp47()).toBe("it-IT")
  })

  test("plural agrees a word with its number in each language: «1 minuto», «2 minuti»", () => {
    const minutes = (count: number, language: "it" | "en") =>
      `${count} ${plural(count, language === "it" ? { one: "minuto", other: "minuti" } : { one: "minute", other: "minutes" }, language)}`
    expect(minutes(1, "it")).toBe("1 minuto")
    expect(minutes(2, "it")).toBe("2 minuti")
    expect(minutes(0, "it")).toBe("0 minuti")
    expect(minutes(1, "en")).toBe("1 minute")
    expect(minutes(5, "en")).toBe("5 minutes")
  })

  test("the texts that counted days, minutes and animations no longer say «1 giorni» or «1 minuti»", () => {
    expect(translate("it", "date.inDays", 1)).toBe("fra 1 giorno")
    expect(translate("it", "date.inDays", 3)).toBe("fra 3 giorni")
    expect(translate("it", "keys.added.days", 1)).toBe("aggiunta 1 giorno fa")
    expect(translate("it", "bots.routine.cap.gap", 1)).toBe("almeno 1 minuto tra due esecuzioni della stessa routine")
    expect(translate("it", "bots.routine.problem.gap", 1)).toBe("Tra due esecuzioni servono almeno 1 minuto.")
    expect(translate("it", "bots.approval.timeout", 1)).toBe("Senza risposta entro 1 minuto vale come Nega.")
    expect(translate("it", "model.state.animations", 1)).toBe("1 animazione")
    expect(translate("en", "date.inDays", 1)).toBe("in 1 day")
    expect(translate("en", "bots.routine.problem.gap", 1)).toBe("Two runs need at least 1 minute between them.")
    expect(translate("en", "model.state.animations", 2)).toBe("2 animations")
  })
})
