import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { ConfirmAction } = await import("./confirm")
const { setLocalePreference } = await import("../i18n")

setLocalePreference("it")

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

function mount(onConfirm: () => void | Promise<void>) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(ConfirmAction, {
        label: "Elimina routine",
        question: "Eliminare questa routine?",
        confirm: "Elimina",
        onConfirm,
      }),
    host,
  )
  const buttons = () => [...document.querySelectorAll("button")]
  const press = (text: string) => buttons().find((button) => button.textContent === text)!.click()
  return { buttons, press }
}

/*
 * D25: every irreversible action on the bot's screens asks the same way. Delete a
 * bot, delete a routine, take a memory out, remove a token, revoke an account.
 */
describe("the one way to confirm what cannot be taken back", () => {
  test("the first press asks, and does nothing", () => {
    let done = 0
    const { buttons, press } = mount(() => void done++)
    expect(buttons().map((button) => button.textContent)).toEqual(["Elimina routine"])
    press("Elimina routine")
    expect(done).toBe(0)
    expect(document.querySelector('[data-slot="bots-confirm-question"]')?.textContent).toBe("Eliminare questa routine?")
    expect(buttons().map((button) => button.textContent)).toEqual(["Annulla", "Elimina"])
  })

  test("«Annulla» puts the first button back and nothing is done", () => {
    let done = 0
    const { buttons, press } = mount(() => void done++)
    press("Elimina routine")
    press("Annulla")
    expect(done).toBe(0)
    expect(buttons().map((button) => button.textContent)).toEqual(["Elimina routine"])
  })

  test("Escape cancels like «Annulla»", () => {
    let done = 0
    const { buttons, press } = mount(() => void done++)
    press("Elimina routine")
    document
      .querySelector('[data-slot="bots-confirm"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    expect(done).toBe(0)
    expect(buttons().map((button) => button.textContent)).toEqual(["Elimina routine"])
  })

  test("P2-P3: the focus goes to «Annulla» when the question opens, Escape from there closes it, and the focus comes back", async () => {
    const { buttons, press } = mount(() => {})
    const first = buttons()[0]!
    first.focus()
    press("Elimina routine")
    await Promise.resolve()
    expect(document.activeElement?.textContent).toBe("Annulla")
    // Escape is read from where the focus is, not from the question's own element.
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    await Promise.resolve()
    expect(buttons().map((button) => button.textContent)).toEqual(["Elimina routine"])
    expect(document.activeElement?.textContent).toBe("Elimina routine")
  })

  test("«Annulla» gives the focus back to the first button too", async () => {
    const { press } = mount(() => {})
    press("Elimina routine")
    await Promise.resolve()
    press("Annulla")
    await Promise.resolve()
    expect(document.activeElement?.textContent).toBe("Elimina routine")
  })

  test("the second press does it, once, and the first button comes back", async () => {
    let done = 0
    const { buttons, press } = mount(async () => void done++)
    press("Elimina routine")
    press("Elimina")
    press("Elimina")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(done).toBe(1)
    expect(buttons().map((button) => button.textContent)).toEqual(["Elimina routine"])
  })

  test("the first button is a danger link, the second a danger button", () => {
    const { press } = mount(() => {})
    expect(document.querySelector('[data-slot="bots-link"][data-tone="danger"]')).not.toBeNull()
    press("Elimina routine")
    expect(document.querySelector('[data-slot="bots-btn"][data-tone="danger"]')).not.toBeNull()
  })
})
