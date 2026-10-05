import { describe, expect, test } from "bun:test"
import {
  CATEGORIES,
  LEGACY_TARGETS,
  DEFAULT_CATEGORY,
  DEFAULT_TAB,
  findCategory,
  findTab,
  isValidCategory,
  isValidTab,
  legacyTarget,
  readLastView,
  resolveTarget,
  saveLastView,
  SETTINGS_VIEW_STORAGE_KEY,
} from "./categories"
import { it } from "../i18n/it"
import { en } from "../i18n/en"

describe("settings categories and tabs", () => {
  test("ogni id vecchio porta a una scheda che esiste", () => {
    for (const [legacyId, target] of Object.entries(LEGACY_TARGETS)) {
      expect(isValidCategory(target.category)).toBe(true)
      const cat = findCategory(target.category)
      expect(cat).toBeDefined()
      const hasTab = cat!.tabs.some((t) => t.id === target.tab)
      expect(`${legacyId} -> ${target.category}/${target.tab}: ${hasTab}`).toBe(
        `${legacyId} -> ${target.category}/${target.tab}: true`,
      )
    }
  })

  test("gli id delle categorie e delle schede sono unici", () => {
    const categoryIds = CATEGORIES.map((c) => c.id)
    const uniqueCategories = new Set(categoryIds)
    expect(categoryIds.length).toBe(uniqueCategories.size)

    const allTabIds = CATEGORIES.flatMap((c) => c.tabs.map((t) => t.id))
    const uniqueTabs = new Set(allTabIds)
    expect(allTabIds.length).toBe(uniqueTabs.size)
  })

  test("non c'è Routine tra le categorie e le schede", () => {
    for (const cat of CATEGORIES) {
      expect(cat.id).not.toBe("routine" as never)
      expect(cat.labelKey).not.toContain("routine")
      for (const tab of cat.tabs) {
        expect(tab.id).not.toContain("routine")
        expect(tab.labelKey).not.toContain("routine")
      }
    }
  })

  test("ogni nome ha la chiave it ed en", () => {
    for (const cat of CATEGORIES) {
      expect(cat.labelKey in it).toBe(true)
      expect(cat.labelKey in en).toBe(true)
      expect(cat.descKey in it).toBe(true)
      expect(cat.descKey in en).toBe(true)
      for (const tab of cat.tabs) {
        expect(tab.labelKey in it).toBe(true)
        expect(tab.labelKey in en).toBe(true)
      }
    }
  })

  test("resolveTarget handles legacy, tabs, categories, and fallbacks", () => {
    expect(resolveTarget()).toEqual({ category: DEFAULT_CATEGORY, tab: DEFAULT_TAB })
    expect(resolveTarget("")).toEqual({ category: DEFAULT_CATEGORY, tab: DEFAULT_TAB })
    expect(resolveTarget("voice-sec-backend")).toEqual({ category: "voice", tab: "voice/recognition" })
    expect(resolveTarget("set-sec-provider")).toEqual({ category: "agents", tab: "agents/account" })
    expect(resolveTarget("set-sec-theme")).toEqual({ category: "general", tab: "general/appearance" })
    expect(resolveTarget("set-sec-routine")).toEqual({ category: "general", tab: "general/appearance" })
    expect(resolveTarget("agents")).toEqual({ category: "agents", tab: "agents/account" })
    expect(resolveTarget("system/space")).toEqual({ category: "system", tab: "system/space" })
    expect(resolveTarget("nonexistent-key")).toEqual({ category: DEFAULT_CATEGORY, tab: DEFAULT_TAB })
  })

  test("last view persistence in localStorage works safely", () => {
    const original = typeof localStorage !== "undefined" ? localStorage.getItem(SETTINGS_VIEW_STORAGE_KEY) : null
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(SETTINGS_VIEW_STORAGE_KEY)
      }

      // Initially empty -> fallback
      expect(readLastView()).toEqual({ category: DEFAULT_CATEGORY, tab: DEFAULT_TAB })

      // Save a valid view
      saveLastView({ category: "agents", tab: "agents/keys" })
      expect(readLastView()).toEqual({ category: "agents", tab: "agents/keys" })

      // Invalid category/tab saved -> fallback
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(SETTINGS_VIEW_STORAGE_KEY, JSON.stringify({ category: "fake", tab: "none" }))
      }
      expect(readLastView()).toEqual({ category: DEFAULT_CATEGORY, tab: DEFAULT_TAB })

      // Malformed JSON -> fallback without crash
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(SETTINGS_VIEW_STORAGE_KEY, "{corrupt json")
      }
      expect(readLastView()).toEqual({ category: DEFAULT_CATEGORY, tab: DEFAULT_TAB })
    } finally {
      if (typeof localStorage !== "undefined") {
        if (original !== null) {
          localStorage.setItem(SETTINGS_VIEW_STORAGE_KEY, original)
        } else {
          localStorage.removeItem(SETTINGS_VIEW_STORAGE_KEY)
        }
      }
    }
  })
})
