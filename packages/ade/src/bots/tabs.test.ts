import { describe, expect, test } from "bun:test"
import { BOT_TABS, movedTab, shownTab, tabButtonId, tabPanelId, tabsOf, TAB_LABEL } from "./tabs"
import { metaWords } from "./page-meta"

/*
 * The bot's page (scelta 1): six tabs in the order the user chose, whole-width
 * sections, nothing on the right. Here the rules; the markup is in
 * `bot-tabs.test.ts` and `page-layout.test.ts`.
 */
describe("the tabs of a bot's page", () => {
  test("are Conversation, Settings, Platforms, Routines, Memory, Permissions, in that order", () => {
    expect([...BOT_TABS]).toEqual(["talk", "settings", "platforms", "routines", "memory", "permissions"])
    expect(Object.keys(TAB_LABEL)).toEqual([...BOT_TABS])
  })

  test("a bot you talk to has all six where the app holds the platforms", () => {
    expect(tabsOf({ mode: "primary" }, { platforms: true })).toEqual([...BOT_TABS])
  })

  test("there is no Platforms tab where there are no gateways (the browser, the official build until G8)", () => {
    expect(tabsOf({ mode: "primary" }, { platforms: false })).toEqual(["talk", "settings", "routines", "memory", "permissions"])
  })

  test("a subagent has no routines and no memory, which are for a bot you talk to", () => {
    expect(tabsOf({ mode: "subagent" }, { platforms: true })).toEqual(["talk", "settings", "platforms", "permissions"])
  })

  test("a tab the bot lacks falls back to the conversation, not to a blank page", () => {
    const tabs = tabsOf({ mode: "subagent" }, { platforms: false })
    expect(shownTab(tabs, "memory")).toBe("talk")
    expect(shownTab(tabs, "settings")).toBe("settings")
  })

  test("the arrows go round, Home and End go to the ends, any other key does nothing", () => {
    const tabs = tabsOf({}, { platforms: true })
    expect(movedTab(tabs, "talk", "ArrowRight")).toBe("settings")
    expect(movedTab(tabs, "permissions", "ArrowRight")).toBe("talk")
    expect(movedTab(tabs, "talk", "ArrowLeft")).toBe("permissions")
    expect(movedTab(tabs, "memory", "Home")).toBe("talk")
    expect(movedTab(tabs, "memory", "End")).toBe("permissions")
    expect(movedTab(tabs, "memory", "a")).toBeUndefined()
    // A tab that is not in the list leads nowhere.
    expect(movedTab(["talk"], "memory", "ArrowRight")).toBeUndefined()
  })

  test("each tab and its panel have an id of their own, tied by the page's prefix", () => {
    const ids = BOT_TABS.flatMap((tab) => [tabButtonId("p", tab), tabPanelId("p", tab)])
    expect(new Set(ids).size).toBe(BOT_TABS.length * 2)
  })
})

describe("the line under the bot's name (D14)", () => {
  const base = { runner: "Ragu Code", model: "Grok 4", spend: "gratis", scope: "solo in questo progetto" }

  test("is in words and carries neither «primary» nor the raw level", () => {
    const words = metaWords({ ...base, effort: "ragionamento alto" })
    expect([words.runner, words.model, words.spend, ...words.rest].join(" · ")).toBe(
      "Ragu Code · Grok 4 · gratis · ragionamento alto · solo in questo progetto",
    )
  })

  test("leaves out what the bot does not have: no level, and the ordinary kind is not said", () => {
    expect(metaWords(base).rest).toEqual(["solo in questo progetto"])
    expect(metaWords({ ...base, subagent: "sottoagente" }).rest).toEqual(["sottoagente", "solo in questo progetto"])
  })
})
