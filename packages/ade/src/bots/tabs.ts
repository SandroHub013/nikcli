/**
 * The bot's page: its tabs, in the order the user chose (`design/ade-bot`, scelta 1).
 *
 * Conversation · Settings · Platforms · Routines · Memory · Permissions. Each is
 * a whole-width section of the page; there is no column on the right, so at
 * any width of the window every section is one press away.
 */

import type { MessageKey } from "../i18n"

export const BOT_TABS = ["talk", "settings", "platforms", "routines", "memory", "permissions"] as const

export type BotTab = (typeof BOT_TABS)[number]

export const TAB_LABEL: Record<BotTab, MessageKey> = {
  talk: "bots.tab.talk",
  settings: "bots.tab.settings",
  platforms: "bots.tab.platforms",
  routines: "bots.tab.routines",
  memory: "bots.tab.memory",
  permissions: "bots.tab.permissions",
}

/**
 * The tabs a bot has. Platforms only where the app holds the gateways (`GATEWAY_ENABLED`, in the desktop app);
 * routines and memory are for a bot you talk to, not for a subagent.
 */
export function tabsOf(bot: { readonly mode?: string }, where: { readonly platforms: boolean }): readonly BotTab[] {
  return BOT_TABS.filter((tab) => {
    if (tab === "platforms") return where.platforms
    if (tab === "routines" || tab === "memory") return bot.mode !== "subagent"
    return true
  })
}

/** The tab the arrow keys, Home and End lead to from `current`; undefined for any other key. */
export function movedTab(tabs: readonly BotTab[], current: BotTab, key: string): BotTab | undefined {
  const index = tabs.indexOf(current)
  if (index < 0 || tabs.length === 0) return undefined
  if (key === "ArrowRight") return tabs[(index + 1) % tabs.length]
  if (key === "ArrowLeft") return tabs[(index - 1 + tabs.length) % tabs.length]
  if (key === "Home") return tabs[0]
  if (key === "End") return tabs[tabs.length - 1]
  return undefined
}

/** The tab to show: the one asked for if the bot has it, the conversation if not. */
export function shownTab(tabs: readonly BotTab[], wanted: BotTab): BotTab {
  return tabs.includes(wanted) ? wanted : "talk"
}

export const tabButtonId = (prefix: string, tab: BotTab) => `${prefix}-tab-${tab}`
export const tabPanelId = (prefix: string, tab: BotTab) => `${prefix}-panel-${tab}`
