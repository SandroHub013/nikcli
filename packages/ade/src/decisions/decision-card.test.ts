import { afterEach, describe, expect, test } from "bun:test"
import { createComponent, render } from "solid-js/web"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { submitControl as decisionControl } from "./card"
import type { Decision } from "./state"

compileSolidJsx()
const { DecisionCard } = await import("./decision-card")

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  document.body.innerHTML = ""
})

const NOW = new Date("2026-10-06T12:00:00.000Z")

function makeDecision(options: Decision["options"]): Decision {
  return {
    k: "D1",
    status: "aperta",
    raisedBy: "Opus",
    order: 1,
    title: "Scelta architettura",
    openedAt: NOW.toISOString(),
    options,
    history: [],
  }
}

describe("DecisionCard option titles and effects (T1)", () => {
  test("renders option.title beside label and option.effect in small", () => {
    const root = document.createElement("div")
    document.body.append(root)

    const decision = makeDecision([
      {
        label: "A",
        title: "Prima strada",
        effect: "Meno codice e zero dipendenze",
      },
      {
        label: "B",
        title: "Seconda strada",
        effect: "Richiede un nuovo pacchetto",
      },
    ])

    cleanup = render(
      () =>
        createComponent(DecisionCard, {
          decision,
          picked: [],
          note: "",
          busy: false,
          recipientHint: "Nessuna sessione",
          now: NOW,
          onPick: () => {},
          onNote: () => {},
          control: decisionControl({
            recipient: { state: "non scelta" },
            sessions: [],
            inline: undefined,
            busy: false,
            label: "Registra",
          }),
          onInline: () => {},
          onSubmit: () => {},
          onRecord: () => {},
          onDefer: () => {},
        }),
      root,
    )

    const buttons = root.querySelectorAll('[data-slot="decision-option"]')
    expect(buttons.length).toBe(2)

    const [optA, optB] = [...buttons] as HTMLButtonElement[]

    // Option A
    const titleA = optA.querySelector('[data-slot="decision-option-text"] b')
    expect(titleA?.textContent).toContain("A · Prima strada")

    const effectA = optA.querySelector('[data-slot="decision-option-effect"]')
    expect(effectA).not.toBeNull()
    expect(effectA?.textContent).toBe("Meno codice e zero dipendenze")

    // Option B
    const titleB = optB.querySelector('[data-slot="decision-option-text"] b')
    expect(titleB?.textContent).toContain("B · Seconda strada")

    const effectB = optB.querySelector('[data-slot="decision-option-effect"]')
    expect(effectB).not.toBeNull()
    expect(effectB?.textContent).toBe("Richiede un nuovo pacchetto")
  })

  test("renders only label when title is absent, and omits effect when absent", () => {
    const root = document.createElement("div")
    document.body.append(root)

    const decision = makeDecision([
      { label: "Sì" },
      { label: "No" },
    ])

    cleanup = render(
      () =>
        createComponent(DecisionCard, {
          decision,
          picked: [],
          note: "",
          busy: false,
          recipientHint: "Nessuna sessione",
          now: NOW,
          onPick: () => {},
          onNote: () => {},
          control: decisionControl({
            recipient: { state: "non scelta" },
            sessions: [],
            inline: undefined,
            busy: false,
            label: "Registra",
          }),
          onInline: () => {},
          onSubmit: () => {},
          onRecord: () => {},
          onDefer: () => {},
        }),
      root,
    )

    const [optYes, optNo] = [...root.querySelectorAll('[data-slot="decision-option"]')] as HTMLButtonElement[]

    const titleYes = optYes.querySelector('[data-slot="decision-option-text"] b')
    expect(titleYes?.textContent).toBe("Sì")
    expect(optYes.querySelector('[data-slot="decision-option-effect"]')).toBeNull()

    const titleNo = optNo.querySelector('[data-slot="decision-option-text"] b')
    expect(titleNo?.textContent).toBe("No")
    expect(optNo.querySelector('[data-slot="decision-option-effect"]')).toBeNull()
  })
})
