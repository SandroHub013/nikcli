import { describe, expect, test } from "bun:test"
import { availableLanguages, isLanguageSupported } from "./languages"

describe("settings/languages - availableLanguages", () => {
  test("returns ISO-639-1 languages for openrouter", () => {
    const langs = availableLanguages("openrouter")
    expect(langs.length).toBeGreaterThanOrEqual(10)
    expect(isLanguageSupported("openrouter", "it")).toBe(true)
    expect(isLanguageSupported("openrouter", "auto")).toBe(true)
  })
})
