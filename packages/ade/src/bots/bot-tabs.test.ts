import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { createSignal } = await import("solid-js")
const { BotTabs } = await import("./bot-tabs")
const { setLocalePreference } = await import("../i18n")
const { tabButtonId, tabPanelId, tabsOf } = await import("./tabs")
type BotTab = import("./tabs").BotTab

setLocalePreference("it")

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

function mount(badges?: Partial<Record<BotTab, number>>) {
  const host = document.createElement("div")
  document.body.append(host)
  const [active, setActive] = createSignal<BotTab>("talk")
  const chosen: BotTab[] = []
  dispose = render(
    () =>
      createComponent(BotTabs, {
        tabs: tabsOf({}, { platforms: true }),
        get active() {
          return active()
        },
        idPrefix: "p",
        ...(badges ? { badges } : {}),
        onSelect: (tab: BotTab) => {
          chosen.push(tab)
          setActive(tab)
        },
      }),
    host,
  )
  const tab = (name: BotTab) => document.querySelector<HTMLButtonElement>(`[data-tab="${name}"]`)!
  return { tab, chosen }
}

describe("the strip of tabs", () => {
  test("is a tablist of six tabs, in the user's words and order", () => {
    mount()
    expect(document.querySelector('[role="tablist"]')).not.toBeNull()
    const names = [...document.querySelectorAll('[role="tab"]')].map((el) => el.textContent)
    expect(names).toEqual(["Conversazione", "Impostazioni", "Piattaforme", "Routine", "Memoria", "Permessi"])
  })

  test("only the open tab is in the tab order, and each names its panel", () => {
    const { tab } = mount()
    expect(tab("talk").tabIndex).toBe(0)
    expect(tab("talk").getAttribute("aria-selected")).toBe("true")
    expect(tab("memory").tabIndex).toBe(-1)
    expect(tab("memory").getAttribute("aria-selected")).toBe("false")
    expect(tab("memory").id).toBe(tabButtonId("p", "memory"))
    expect(tab("memory").getAttribute("aria-controls")).toBe(tabPanelId("p", "memory"))
  })

  test("a press opens the tab; the arrow moves to the next and puts the focus on it", () => {
    const { tab, chosen } = mount()
    tab("permissions").click()
    expect(chosen).toEqual(["permissions"])
    tab("permissions").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
    expect(chosen).toEqual(["permissions", "talk"])
    expect(document.activeElement).toBe(tab("talk"))
    tab("talk").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }))
    expect(chosen.at(-1)).toBe("permissions")
  })

  test("a count shows on its tab, and nothing for zero", () => {
    mount({ platforms: 2, memory: 0 })
    expect(document.querySelector('[data-tab="platforms"] [data-slot="bots-tab-badge"]')?.textContent).toBe("2")
    expect(document.querySelector('[data-tab="memory"] [data-slot="bots-tab-badge"]')).toBeNull()
  })
})
