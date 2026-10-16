import { readFileSync } from "node:fs"
import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { en } from "../i18n/en"
import { it as itDict } from "../i18n/it"
import { compileSolidJsx } from "../test-support/solid-jsx"
import type { AgentFile } from "./ragu"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { NewBotCapField, SpendCapField, SPEND_CAP_PROPOSED_USD } = await import("./spend-panel")
const { memorySpendStore, withCap, NO_SPEND } = await import("./spend")
const { ACCOUNT_PLAN } = await import("./account")
const { setLocalePreference } = await import("../i18n")

setLocalePreference("it")

/*
 * Where the daily cap is asked (Master, 2026-10-16): when a bot that spends money is made, with a value
 * proposed; and in the Impostazioni of a paid bot that has none, as a notice beside the field.
 */
const BOT = (runner: string, model?: string): AgentFile => ({
  identifier: "contabile",
  path: "C:/u/.nikcli/agent/contabile.md",
  scope: "global",
  description: "",
  mode: "primary",
  prompt: "",
  disabledTools: [],
  runner,
  ...(model ? { model } : {}),
})

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

const host = () => {
  const element = document.createElement("div")
  document.body.append(element)
  return element
}

describe("the Impostazioni of a bot that spends money", () => {
  test("a paid bot with no cap gets a notice beside the field; with a cap, it does not", () => {
    const store = memorySpendStore()
    dispose = render(
      () => createComponent(SpendCapField, { bot: BOT("ragu", "openrouter/some/model"), account: ACCOUNT_PLAN, store }),
      host(),
    )
    expect(document.querySelector('[role="status"]')?.textContent).toBe(String(itDict["bots.daily.missing"]))
    expect(document.querySelector("input")).not.toBeNull()
    dispose()
    document.body.innerHTML = ""

    store.set(BOT("ragu").path, withCap(NO_SPEND, 2))
    dispose = render(
      () => createComponent(SpendCapField, { bot: BOT("ragu", "openrouter/some/model"), account: ACCOUNT_PLAN, store }),
      host(),
    )
    expect(document.querySelector('[role="status"]')).toBeNull()
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("2")
  })

  test("a bot on a subscription or a free model is not asked for a cap", () => {
    for (const bot of [BOT("claude"), BOT("ragu", "x/y:free")]) {
      dispose = render(
        () => createComponent(SpendCapField, { bot, account: ACCOUNT_PLAN, store: memorySpendStore() }),
        host(),
      )
      expect(document.querySelector("input")).toBeNull()
      dispose()
      document.body.innerHTML = ""
    }
  })
})

describe("a new bot that spends money", () => {
  const field = (runner: string, model: string | undefined, free?: boolean) => {
    const seen: string[] = []
    dispose = render(
      () =>
        createComponent(NewBotCapField, {
          runner,
          model,
          free,
          value: "1",
          onInput: (text: string) => void seen.push(text),
        }),
      host(),
    )
    return seen
  }

  test("a paid model asks for the cap, with the value proposed", () => {
    expect(SPEND_CAP_PROPOSED_USD).toBe(1)
    const seen = field("ragu", "openrouter/some/model")
    const input = document.querySelector("input") as HTMLInputElement
    expect(input.value).toBe("1")
    expect(document.body.textContent).toContain(String(itDict["bots.daily.newHint"]))
    input.value = ""
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(seen).toEqual([""])
  })

  test("a free model, by suffix or by the catalog, and a subscription runner are not asked", () => {
    field("ragu", "x/y:free")
    expect(document.querySelector("input")).toBeNull()
    dispose?.()
    document.body.innerHTML = ""
    field("ragu", "openrouter/free-by-catalog", true)
    expect(document.querySelector("input")).toBeNull()
    dispose?.()
    document.body.innerHTML = ""
    field("claude", undefined)
    expect(document.querySelector("input")).toBeNull()
  })
})

describe("the page asks for it", () => {
  const bots = readFileSync(new URL("./bots.tsx", import.meta.url), "utf8")

  test("lint: the form reads the cap before it makes the bot, and keeps it with the new bot's path", () => {
    const form = bots.slice(bots.indexOf("function BotForm"), bots.indexOf("function BotSettings"))
    expect(form).toContain("parseCap(cap())")
    expect(form.indexOf("parseCap(cap())")).toBeLessThan(form.indexOf("await createBot("))
    expect(form).toContain("appSpendStore.set(result.path")
    expect(form).toContain("<NewBotCapField")
  })

  test("lint: the Impostazioni mount the pieces for the bot, with the catalog's word on the model", () => {
    const tab = bots.slice(bots.indexOf("function SettingsTab"))
    expect(tab).toContain("<SpendTodayLine")
    expect(tab).toContain("<SpendCapField")
    expect(tab).toContain("catalogFreeOf(bot)")
  })

  test("the words are in both languages and differ", () => {
    for (const key of ["bots.daily.title", "bots.daily.missing", "bots.daily.newHint"]) {
      expect(String((itDict as Record<string, unknown>)[key]).length, key).toBeGreaterThan(3)
      expect(String((en as Record<string, unknown>)[key]).length, key).toBeGreaterThan(3)
      expect((itDict as Record<string, unknown>)[key], key).not.toBe((en as Record<string, unknown>)[key])
    }
  })
})
