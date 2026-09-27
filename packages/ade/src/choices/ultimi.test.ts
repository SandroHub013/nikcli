import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRoot, createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { submitControl as decisionControl } from "../decisions/card"
import { parseDecisionLog } from "../decisions/log"
import { foldDecisions } from "../decisions/state"
import { queueShown } from "../surface/bar-queue"
import { createSettled } from "../surface/settled"
import { compileSolidJsx } from "../test-support/solid-jsx"

// The card is `.tsx`: compiled for bun, and imported only after it.
compileSolidJsx()
const { DecisionCard } = await import("../decisions/decision-card")

/* Verifiche on 7fa40dc20: the last two touches of «Da scegliere». */
const NOW = new Date("2026-09-27T12:00:00.000Z")
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The name a screen reader gives a node: its text, without what is aria-hidden. */
function spoken(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return ""
  return [...node.childNodes].map(spoken).join("")
}

describe("ultimi 1: the recommended option's name", () => {
  let dispose: (() => void) | undefined
  afterEach(() => {
    dispose?.()
    dispose = undefined
    document.body.innerHTML = ""
  })

  test("reads «Sì, consigliata», not «SìConsigliata», and the badge is still seen", () => {
    const decision = foldDecisions(
      parseDecisionLog(
        JSON.stringify({
          type: "aperta",
          k: "D1",
          at: NOW.toISOString(),
          by: "Sessione 1 — Terminal",
          title: "Prova",
          context: "Il riquadro.",
          recommend: { option: "Sì" },
          options: [{ label: "Sì", detail: "va bene" }, { label: "No" }],
        }),
      ).events,
      NOW,
    ).decisions[0]!
    const host = document.createElement("div")
    document.body.append(host)
    dispose = render(
      () =>
        createComponent(DecisionCard, {
          decision,
          picked: undefined,
          note: "",
          busy: false,
          recipientHint: "",
          now: NOW,
          onPick: () => {},
          onNote: () => {},
          onInline: () => {},
          onSubmit: () => {},
          onRecord: () => {},
          onDefer: () => {},
          control: decisionControl({
            recipient: { state: "non scelta" },
            sessions: [],
            inline: undefined,
            busy: false,
            label: "R",
          }),
        }) as never,
      host,
    )
    const [yes, no] = [...host.querySelectorAll('[data-slot="decision-option"]')]
    const name = spoken(yes!).replace(/\s+/g, " ").trim()
    expect(name).not.toContain("SìConsigliata")
    expect(name).toContain("Sì, consigliata,")
    expect(yes!.querySelector('[data-slot="choice-recommended"]')?.textContent).toBe("Consigliata")
    expect(spoken(no!)).not.toContain("consigliata")
  })
})

describe("ultimi 2: no «0» on the button while an answer is on its way", () => {
  test("a queued answer delivered within the settle time never shows the button", async () => {
    await createRoot(async (dispose) => {
      const [queued, setQueued] = createSignal(0)
      const settled = createSettled(queued, 60)
      const shown: boolean[] = []
      const look = () => shown.push(queueShown({ waiting: 0, queued: settled(), discarded: 0 }))
      // The last answer: nothing waits, the answer is queued, and taken half a moment later.
      setQueued(1)
      look()
      await wait(20)
      look()
      setQueued(0)
      look()
      await wait(80)
      look()
      expect(shown).toEqual([false, false, false, false])
      dispose()
    })
  })

  test("one that stays queued shows, and goes at once when it is taken", async () => {
    await createRoot(async (dispose) => {
      const [queued, setQueued] = createSignal(0)
      const settled = createSettled(queued, 30)
      setQueued(1)
      expect(settled()).toBe(0)
      await wait(50)
      expect(settled()).toBe(1)
      setQueued(2)
      expect(settled()).toBe(2)
      setQueued(0)
      expect(settled()).toBe(0)
      dispose()
    })
  })

  test("lint: the button's counts take the settled queue", () => {
    const workbench = readFileSync(join(import.meta.dir, "..", "surface", "workbench.tsx"), "utf8")
    expect(workbench).toContain("const settledQueued = createSettled(() => decisionsQueued() + designQueued())")
    expect(workbench).toContain("queued: settledQueued(),")
  })
})
