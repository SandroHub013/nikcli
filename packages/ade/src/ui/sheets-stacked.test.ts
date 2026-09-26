import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createSignal, Show, type JSX } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { Sheet, SheetTitle } from "./sheet"
import type { RecordConsent } from "../record/record-panel"
import type { KeysHost } from "../secrets/keys-section"
import { compileSolidJsx } from "../test-support/solid-jsx"

// The two dialogs are `.tsx`: compiled for bun as the hub tests do.
compileSolidJsx()
const { RecordConsentDialog } = await import("../record/consent-dialog")
const { KeyRequestDialog } = await import("../secrets/keys-section")

/*
 * kobalte-overlay review, M2: the two questions an agent opens by itself, the
 * recording consent (`record start`) and the key request (`keys ask`), came on
 * the old Overlay. With a sheet open they opened under its focus trap: on
 * screen, and deaf to the keyboard until the sheet was closed. Rendered here
 * over an open sheet, as it happens.
 */
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
let cleanup: (() => void) | undefined

// As in sheet.test.ts: happy-dom sends no `focusin` on `.focus()`, and Kobalte's trap listens to it.
const nativeFocus = HTMLElement.prototype.focus
beforeAll(() => {
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    const before = document.activeElement
    nativeFocus.call(this, options)
    if (document.activeElement === this && before !== this) this.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
  }
})
afterAll(() => {
  HTMLElement.prototype.focus = nativeFocus
})
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  document.body.innerHTML = ""
})

const when = Show as (props: { when: boolean; children: JSX.Element }) => JSX.Element

/** A sheet already open (Decisioni), and the agent's question arriving over it. */
async function over(question: (close: () => void) => JSX.Element) {
  const opener = document.createElement("button")
  document.body.append(opener)
  opener.focus()
  const [asking, setAsking] = createSignal(false)
  let lower: HTMLDivElement | undefined
  cleanup = render(
    () => [
      createComponent(Sheet, {
        component: "decisions-sheet",
        onClose: () => {},
        ref: (element: HTMLDivElement) => (lower = element),
        get children() {
          return createComponent(SheetTitle, { children: "Decisioni" })
        },
      }),
      createComponent(when, {
        get when() {
          return asking()
        },
        get children() {
          return question(() => setAsking(false))
        },
      }),
    ],
    document.body.appendChild(document.createElement("div")),
  )
  await tick()
  expect(lower!.contains(document.activeElement)).toBe(true)
  setAsking(true)
  await tick()
  return { lower: lower!, asking }
}

describe("an agent's question over an open sheet", () => {
  test("the recording consent comes on top with the keys, and Esc refuses once, leaving the sheet", async () => {
    const answers: RecordConsent[] = []
    const { lower, asking } = await over((close) =>
      createComponent(RecordConsentDialog, {
        target: { kind: "window" },
        asker: "Master",
        onAnswer: (answer: RecordConsent) => {
          answers.push(answer)
          close()
        },
      }),
    )
    const consent = document.querySelector<HTMLElement>('[data-component="record-consent"] [role="alertdialog"]')
    expect(consent).not.toBeNull()
    expect(consent!.contains(document.activeElement)).toBe(true)
    // The safe answer is the one under the focus: «No».
    expect(document.activeElement?.getAttribute("data-slot")).toBe("decision-ghost")
    consent!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await tick()
    expect(answers).toEqual([{ allowed: false, mic: false }])
    expect(asking()).toBe(false)
    expect(lower.isConnected).toBe(true)
    expect(lower.contains(document.activeElement)).toBe(true)
  })

  test("the key request comes on top with the keys, and Esc closes it once, leaving the sheet", async () => {
    const closed: (string | undefined)[] = []
    // Fake keys only: nothing here is read from or written to a keychain.
    const host: KeysHost = {
      list: async () => [],
      save: async () => {},
      remove: async () => {},
      copy: async () => 0,
    }
    const { lower, asking } = await over((close) =>
      createComponent(KeyRequestDialog, {
        host,
        agents: [],
        env: "FAKE_API_KEY",
        reason: "per un test",
        onClose: (saved: string | undefined) => {
          closed.push(saved)
          close()
        },
      }),
    )
    const request = document.querySelector<HTMLElement>('[data-component="key-request"] [role="dialog"]')
    expect(request).not.toBeNull()
    expect(request!.contains(document.activeElement)).toBe(true)
    const title = request!.querySelector("strong")
    expect(request!.getAttribute("aria-labelledby")).toBe(title?.id ?? "missing")
    request!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await tick()
    expect(closed).toEqual([undefined])
    expect(asking()).toBe(false)
    expect(lower.isConnected).toBe(true)
    expect(lower.contains(document.activeElement)).toBe(true)
  })
})
