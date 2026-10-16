import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { volatileMemoryStore } from "./memory"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { MemorySection } = await import("./memory-panel")
const { setLocalePreference } = await import("../i18n")

setLocalePreference("it")

/* D25 and D22 on the memory: taking a note out asks first, and the section and its fields have names. */
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

function mount() {
  const store = volatileMemoryStore()
  store.set("bot", { notes: ["Preferisce risposte brevi"], user: [] })
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => createComponent(MemorySection, { bot: "bot", store }), host)
  return { store }
}

const press = (text: string) =>
  [...document.querySelectorAll("button")].find((button) => button.textContent === text)!.click()

describe("the memory section", () => {
  test("taking a note out asks first, and the note stays until the second press", () => {
    const { store } = mount()
    press("Togli")
    expect(store.get("bot").notes).toEqual(["Preferisce risposte brevi"])
    expect(document.querySelector('[data-slot="bots-confirm-question"]')?.textContent).toContain("Preferisce risposte brevi")
    press("Annulla")
    expect(store.get("bot").notes).toEqual(["Preferisce risposte brevi"])
    press("Togli")
    // Two buttons now: «Annulla» and the danger one, also called «Togli».
    ;[...document.querySelectorAll('[data-slot="bots-btn"][data-tone="danger"]')][0]!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    )
    expect(store.get("bot").notes).toEqual([])
  })

  test("the section has a title, and the two fields to add an entry have different names", () => {
    mount()
    const title = document.querySelector('h3[data-slot="bots-section-title"]')!
    expect(title).not.toBeNull()
    expect(document.querySelector("section")?.getAttribute("aria-labelledby")).toBe(title.id)
    const names = [...document.querySelectorAll("form input")].map((input) => input.getAttribute("aria-label"))
    expect(names.length).toBe(2)
    expect(new Set(names).size).toBe(2)
    for (const name of names) expect(name).toMatch(/^Nuova voce in: /)
  })

  test("an empty block says where to add", () => {
    mount()
    expect(document.body.textContent).toContain("Vuoto: aggiungi una voce qui sotto.")
  })
})
