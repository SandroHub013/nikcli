import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { DANGEROUS, localAlwaysStore, withAlways, type AlwaysStore } from "./approval"
import { forgetBotTraces } from "./forget"
import { alwaysApplies, alwaysText } from "./permissions-always"
import type { AgentFile } from "./ragu"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { PermissionsSection } = await import("./permissions-panel")
const { setLocalePreference, t } = await import("../i18n")

setLocalePreference("it")

/* The «Sempre» a bot has, seen in its Permissions tab and taken back one by one (the user's choice 4). */
const BOT: AgentFile = {
  identifier: "alfa",
  path: "C:/u/.nikcli/agent/alfa.md",
  scope: "global",
  description: "",
  mode: "primary",
  prompt: "",
  disabledTools: [],
  runner: "ragu",
}

/** A storage that is only a map, for the real `localAlwaysStore`. */
function storage() {
  const saved = new Map<string, string>()
  return {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
  }
}

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

function mount(bot: AgentFile, always: AlwaysStore | undefined) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => createComponent(PermissionsSection, { bot, ...(always ? { always } : {}) }), host)
  const section = () => host.querySelector('[aria-labelledby="bots-permissions-always"]')
  return {
    section,
    items: () => [...(section()?.querySelectorAll("li") ?? [])].map((item) => item.querySelector("span")?.textContent),
    take: (index: number) => (section()!.querySelectorAll("button")[index] as HTMLButtonElement).click(),
  }
}

describe("the words of a «Sempre»", () => {
  test("every kind of danger a «Sempre» can keep has its reason in words, capitalised", () => {
    for (const rule of DANGEROUS.filter((one) => one.always !== false)) {
      const reason = t(rule.reason)
      expect(alwaysText(rule.id), rule.id).toBe(reason.charAt(0).toUpperCase() + reason.slice(1))
    }
    expect(alwaysText("recursiveDelete")).toBe("Cancella una cartella con tutto il contenuto")
  })

  test("a folder outside the project, a tool, and a key this version does not know", () => {
    expect(alwaysText("outside:C:/Users/me/Documents/*")).toBe("Scrivere fuori dal progetto, in «C:/Users/me/Documents/*»")
    expect(alwaysText("tool:webfetch")).toBe("Usare «webfetch» senza chiedere")
    expect(alwaysText("domani")).toBe("domani")
  })

  test("it means something for ragu and Claude Code, which ask or are refused, not for Codex", () => {
    expect(alwaysApplies("ragu")).toBe(true)
    expect(alwaysApplies("claude")).toBe(true)
    expect(alwaysApplies("codex")).toBe(false)
  })
})

describe("the list in Permissions", () => {
  test("each «Sempre» of the bot is listed with «Togli»; the others' are not", () => {
    const always = localAlwaysStore(storage())
    always.add(BOT.path, "recursiveDelete")
    always.add(BOT.path, "outside:C:/dati/*")
    always.add("C:/u/.nikcli/agent/beta.md", "gitRewrite")
    const view = mount(BOT, always)
    expect(view.items()).toEqual(["Cancella una cartella con tutto il contenuto", "Scrivere fuori dal progetto, in «C:/dati/*»"])
    expect([...view.section()!.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Togli", "Togli"])
  })

  test("«Togli» takes that one back, in the store the Conversation gives them to; the danger is asked again", async () => {
    const always = localAlwaysStore(storage())
    always.add(BOT.path, "recursiveDelete")
    always.add(BOT.path, "gitRewrite")
    const view = mount(BOT, always)
    view.take(0)
    expect(always.get(BOT.path)).toEqual(["gitRewrite"])
    expect(view.items()).toEqual(["Riscrive la storia di git o butta via lavoro non salvato"])
    view.take(0)
    expect(always.get(BOT.path)).toEqual([])
    expect(view.section()!.textContent).toContain(t("bots.permissions.alwaysEmpty"))
    // What `decide` reads is what the list shows: nothing kept, the danger is asked.
    const { decide } = await import("./approval")
    expect(decide("bash", "rm -rf build", always.get(BOT.path)).kind).toBe("ask")
  })

  test("deleting the bot clears the same store the list reads", () => {
    const storeStorage = storage()
    const always = localAlwaysStore(storeStorage)
    always.add(BOT.path, withAlways([], "recursiveDelete").join())
    const view = mount(BOT, always)
    expect(view.items()).toHaveLength(1)
    forgetBotTraces(
      BOT.path,
      {
        memory: { get: () => ({ blocks: {} }) as never, set: () => {} },
        account: { get: () => ({ mode: "plan" }), set: () => {} },
        remote: { get: () => ({ commands: false }), set: () => {} },
        routines: () => {},
        always,
      },
    )
    expect(always.get(BOT.path)).toEqual([])
  })

  test("Codex has no list: it never asks, so there is nothing to give; no store, no section", () => {
    const always = localAlwaysStore(storage())
    always.add(BOT.path, "recursiveDelete")
    expect(mount({ ...BOT, runner: "codex" }, always).section()).toBeNull()
    dispose?.()
    document.body.innerHTML = ""
    expect(mount(BOT, undefined).section()).toBeNull()
  })

  test("an empty list says so, and that a «Sempre» is the Conversation's, not the phone's", () => {
    const view = mount(BOT, localAlwaysStore(storage()))
    expect(view.items()).toEqual([])
    expect(view.section()!.textContent).toContain("Nessuno")
    expect(view.section()!.textContent).toContain("non dal telefono")
  })
})
