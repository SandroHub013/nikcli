/**
 * Categories, tabs, and target resolution for the settings panel.
 *
 * Governs the 6 categories (General, Agents, Extensions, Voice, Record, System),
 * their tab hierarchies, persistence of the last viewed page in localStorage,
 * and backwards-compatible legacy ID mapping.
 */

import type { it } from "../i18n/it"

export type CategoryId = "general" | "agents" | "extensions" | "voice" | "record" | "system"

export type I18nKey = keyof typeof it

export interface TabItem {
  readonly id: string
  readonly labelKey: I18nKey
}

export interface CategoryItem {
  readonly id: CategoryId
  readonly labelKey: I18nKey
  readonly descKey: I18nKey
  readonly tabs: readonly TabItem[]
}

export const CATEGORIES: readonly CategoryItem[] = [
  {
    id: "general",
    labelKey: "settings.category.general",
    descKey: "settings.category.general.desc",
    tabs: [
      { id: "general/appearance", labelKey: "settings.tab.appearance" },
      { id: "general/language", labelKey: "settings.tab.language" },
      { id: "general/grid", labelKey: "settings.tab.grid" },
    ],
  },
  {
    id: "agents",
    labelKey: "settings.category.agents",
    descKey: "settings.category.agents.desc",
    tabs: [
      { id: "agents/account", labelKey: "settings.tab.account" },
      { id: "agents/keys", labelKey: "settings.tab.keys" },
      { id: "agents/bots", labelKey: "settings.tab.bots" },
      { id: "agents/resume", labelKey: "settings.tab.resume" },
    ],
  },
  {
    id: "extensions",
    labelKey: "settings.category.extensions",
    descKey: "settings.category.extensions.desc",
    tabs: [
      { id: "extensions/installed", labelKey: "settings.tab.installed" },
      { id: "extensions/mcp", labelKey: "settings.tab.mcp" },
      { id: "extensions/plugins", labelKey: "settings.tab.plugins" },
    ],
  },
  {
    id: "voice",
    labelKey: "settings.category.voice",
    descKey: "settings.category.voice.desc",
    tabs: [
      { id: "voice/mode", labelKey: "settings.tab.voiceMode" },
      { id: "voice/activation", labelKey: "settings.tab.voiceActivation" },
      { id: "voice/shortcuts", labelKey: "settings.tab.voiceShortcuts" },
      { id: "voice/language", labelKey: "settings.tab.voiceLanguage" },
      { id: "voice/devices", labelKey: "settings.tab.voiceDevices" },
      { id: "voice/recognition", labelKey: "settings.tab.voiceRecognition" },
      { id: "voice/reply", labelKey: "settings.tab.voiceReply" },
      { id: "voice/commands", labelKey: "settings.tab.voiceCommands" },
    ],
  },
  {
    id: "record",
    labelKey: "settings.category.record",
    descKey: "settings.category.record.desc",
    tabs: [
      { id: "record/video", labelKey: "settings.tab.recordVideo" },
    ],
  },
  {
    id: "system",
    labelKey: "settings.category.system",
    descKey: "settings.category.system.desc",
    tabs: [
      { id: "system/updates", labelKey: "settings.tab.updates" },
      { id: "system/space", labelKey: "settings.tab.space" },
    ],
  },
]

export const LEGACY_TARGETS: Readonly<Record<string, { category: CategoryId; tab: string }>> = {
  "voice-sec-mode": { category: "voice", tab: "voice/mode" },
  "voice-sec-activation": { category: "voice", tab: "voice/activation" },
  "voice-sec-shortcuts": { category: "voice", tab: "voice/shortcuts" },
  "voice-sec-language": { category: "voice", tab: "voice/language" },
  "voice-sec-devices": { category: "voice", tab: "voice/devices" },
  "voice-sec-backend": { category: "voice", tab: "voice/recognition" },
  "voice-sec-reply": { category: "voice", tab: "voice/reply" },
  "voice-sec-commands": { category: "voice", tab: "voice/commands" },
  "set-sec-theme": { category: "general", tab: "general/appearance" },
  "set-sec-language": { category: "general", tab: "general/language" },
  "set-sec-routine": { category: "general", tab: "general/appearance" },
  "set-sec-bot": { category: "agents", tab: "agents/bots" },
  "set-sec-skills": { category: "agents", tab: "agents/bots" },
  "set-sec-code": { category: "general", tab: "general/grid" },
  "set-sec-provider": { category: "agents", tab: "agents/account" },
  "set-sec-keys": { category: "agents", tab: "agents/keys" },
  "set-sec-extensions": { category: "extensions", tab: "extensions/installed" },
  "set-sec-space": { category: "system", tab: "system/space" },
}

export const DEFAULT_CATEGORY: CategoryId = "general"
export const DEFAULT_TAB = "general/appearance"

export function legacyTarget(id: string): { category: CategoryId; tab: string } | undefined {
  return LEGACY_TARGETS[id]
}

export function isValidCategory(id: string): id is CategoryId {
  return CATEGORIES.some((c) => c.id === id)
}

export function isValidTab(tabId: string): boolean {
  return CATEGORIES.some((c) => c.tabs.some((t) => t.id === tabId))
}

export function findCategory(categoryId: string): CategoryItem | undefined {
  return CATEGORIES.find((c) => c.id === categoryId)
}

export function findTab(tabId: string): { category: CategoryItem; tab: TabItem } | undefined {
  for (const category of CATEGORIES) {
    const tab = category.tabs.find((t) => t.id === tabId)
    if (tab) return { category, tab }
  }
  return undefined
}

export function resolveTarget(target?: string): { category: CategoryId; tab: string } {
  if (!target) return { category: DEFAULT_CATEGORY, tab: DEFAULT_TAB }
  const legacy = legacyTarget(target)
  if (legacy) return legacy
  if (isValidCategory(target)) {
    const cat = findCategory(target)!
    return { category: cat.id, tab: cat.tabs[0]?.id ?? DEFAULT_TAB }
  }
  const match = findTab(target)
  if (match) return { category: match.category.id, tab: match.tab.id }
  return { category: DEFAULT_CATEGORY, tab: DEFAULT_TAB }
}

export const SETTINGS_VIEW_STORAGE_KEY = "ade.settings.view"

export function readLastView(): { category: CategoryId; tab: string } {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SETTINGS_VIEW_STORAGE_KEY) : null
    if (raw) {
      const parsed = JSON.parse(raw) as { category?: string; tab?: string }
      if (parsed && typeof parsed.category === "string" && typeof parsed.tab === "string") {
        if (isValidCategory(parsed.category) && isValidTab(parsed.tab)) {
          const found = findCategory(parsed.category)
          if (found?.tabs.some((t) => t.id === parsed.tab)) {
            return { category: parsed.category, tab: parsed.tab }
          }
        }
      }
    }
  } catch {
    // Ignore storage parse or access errors
  }
  return { category: DEFAULT_CATEGORY, tab: DEFAULT_TAB }
}

export function saveLastView(view: { category: CategoryId; tab: string }): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SETTINGS_VIEW_STORAGE_KEY, JSON.stringify(view))
    }
  } catch {
    // Ignore storage write errors (e.g. quota or security sandbox)
  }
}
