import { afterEach, describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import type { KeysHost } from "./keys-section"
import { compileSolidJsx } from "../test-support/solid-jsx"

compileSolidJsx()
const { KeyRequestDialog } = await import("./keys-section")

/*
 * Full review 2026-10-06, bots 10: a second `@ade keys ask` while the dialog is open changed the title and left the
 * form on the first key, with the first agent ticked.
 */
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  document.body.innerHTML = ""
})

// Fake keys only: nothing here is read from or written to a keychain.
const host: KeysHost = {
  list: async () => [],
  save: async () => {},
  remove: async () => {},
  copy: async () => 0,
}
const agents = [
  { id: "a1", label: "Agente uno", command: "uno" },
  { id: "a2", label: "Agente due", command: "due" },
]

describe("a second key request while the dialog is open", () => {
  test("the form follows the new request: its variable and its agent, not the first's", async () => {
    const [env, setEnv] = createSignal("FOO_API_KEY")
    const [asker, setAsker] = createSignal({ title: "Sessione 1", agentId: "a1" })
    cleanup = render(
      () =>
        createComponent(KeyRequestDialog, {
          host,
          agents,
          get env() {
            return env()
          },
          reason: "per un test",
          get asker() {
            return asker()
          },
          onClose: () => {},
        }),
      document.body.appendChild(document.createElement("div")),
    )
    await tick()
    const envField = () => document.querySelectorAll<HTMLInputElement>('[data-slot="keys-field"] input[type="text"]')[1]!
    const ticked = () =>
      [...document.querySelectorAll<HTMLInputElement>('[data-slot="keys-agent"] input')].map((box) => box.checked)
    expect(envField().value).toBe("FOO_API_KEY")
    expect(ticked()).toEqual([true, false])

    // The second agent asks, before the first form is saved.
    setEnv("BAR_API_KEY")
    setAsker({ title: "Sessione 2", agentId: "a2" })
    await tick()
    expect(envField().value).toBe("BAR_API_KEY")
    expect(ticked()).toEqual([false, true])
  })
})
