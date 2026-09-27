import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createComponent, render } from "solid-js/web"
import { submitControl as decisionControl } from "../decisions/card"
import { parseDecisionLog } from "../decisions/log"
import { foldDecisions } from "../decisions/state"
import { submitControl as designControl } from "../design/card"
import { parseDesignLog } from "../design/log"
import { foldProposals } from "../design/state"
import { createToast } from "../surface/toast"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { askerName, distinctNames, isRecommended } from "./list"

// The cards are `.tsx`: compiled for bun, and imported only after it.
compileSolidJsx()
const { DesignCard } = await import("../design/design-card")
const { DecisionCard } = await import("../decisions/decision-card")

/*
 * Verifiche's three touches after «Da scegliere» went live (fdd1276dd):
 * the card's «da …» without (1)/(2), the sheet's last line lost when it
 * closes, and no mark on the recommended variant.
 */
const NOW = new Date("2026-09-27T11:30:00.000Z")
const src = join(import.meta.dir, "..")
const read = (path: string) => readFileSync(join(src, path), "utf8")

const decision = () =>
  foldDecisions(
    parseDecisionLog(
      JSON.stringify({
        type: "aperta",
        k: "D1",
        at: NOW.toISOString(),
        by: "Sessione 1 — Terminal",
        fromPane: "p2",
        title: "Prova",
        context: "Il riquadro.",
        recommend: { option: "Sì" },
        options: [{ label: "Sì" }, { label: "No" }],
      }),
    ).events,
    NOW,
  ).decisions[0]!
const proposal = () =>
  foldProposals(
    parseDesignLog(
      JSON.stringify({
        type: "aperta",
        k: "DS1",
        at: NOW.toISOString(),
        by: "Sessione 1 — Terminal",
        fromPane: "p1",
        title: "Colore",
        context: "Tre varianti.",
        recommend: { option: "B · viola" },
        variants: [
          { name: "A · verde", description: "", preview: "" },
          { name: "B · viola", description: "", preview: "" },
        ],
      }),
    ).events,
  ).proposals[0]!

const panes = [
  { id: "p1", title: "Sessione 1 — Terminal" },
  { id: "p2", title: "Sessione 1 — Terminal" },
]
const candidates = () => {
  const names = distinctNames(panes)
  return panes.map((pane) => ({ id: pane.id, title: names.get(pane.id)! }))
}

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})
const mount = (component: () => unknown) => {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(component as () => never, host)
  return host
}
const common = {
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
}
const designCard = (askedBy?: string) =>
  mount(() =>
    createComponent(DesignCard, {
      ...common,
      proposal: proposal(),
      ...(askedBy ? { askedBy } : {}),
      onAgain: () => {},
      control: designControl({
        recipient: { state: "non scelta" },
        sessions: [],
        inline: undefined,
        busy: false,
        label: "I",
      }),
    }),
  )
const decisionCard = (askedBy?: string) =>
  mount(() =>
    createComponent(DecisionCard, {
      ...common,
      decision: decision(),
      ...(askedBy ? { askedBy } : {}),
      onDefer: () => {},
      control: decisionControl({
        recipient: { state: "non scelta" },
        sessions: [],
        inline: undefined,
        busy: false,
        label: "R",
      }),
    }),
  )

describe("rifiniture 1: the card's «da …» tells the two panes apart", () => {
  test("askerName: the open pane's told-apart name, the register's title when it is gone", () => {
    expect(askerName(proposal(), candidates())).toBe("Sessione 1 — Terminal (1)")
    expect(askerName(decision(), candidates())).toBe("Sessione 1 — Terminal (2)")
    expect(askerName(decision(), [])).toBe("Sessione 1 — Terminal")
  })

  test("the cards say it under the title", () => {
    const design = designCard(askerName(proposal(), candidates()))
    expect(design.querySelector('[data-slot="design-meta"]')?.textContent).toContain("da Sessione 1 — Terminal (1)")
    const plain = decisionCard()
    expect(plain.querySelector('[data-slot="decision-meta"]')?.textContent).toContain("da Sessione 1 — Terminal ·")
  })

  test("lint: both sheets and both panels give the cards askedBy from askerName", () => {
    for (const path of [
      "design/design-sheet.tsx",
      "decisions/decisions-sheet.tsx",
      "design/design-pane.tsx",
      "decisions/decisions-pane.tsx",
    ])
      expect(read(path)).toMatch(/askedBy=\{askerName\((proposal|decision)(\(\))?, props\.hub\.sessions\(\)\)\}/)
  })
})

describe("rifiniture 2: the sheet's last line outlives the sheet", () => {
  test("a toast shows the line, goes by itself, and a new line starts its time again", async () => {
    const toast = createToast(40)
    toast.show("DS1: B · viola, a Sessione 1 — Terminal (1)")
    expect(toast.text()).toBe("DS1: B · viola, a Sessione 1 — Terminal (1)")
    await new Promise((resolve) => setTimeout(resolve, 25))
    toast.show("D1: Sì, a Sessione 1 — Terminal (2)")
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(toast.text()).toBe("D1: Sì, a Sessione 1 — Terminal (2)")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(toast.text()).toBeUndefined()
  })

  test("lint: the sheets hand their last line to onDone, and the workbench shows it as a toast", () => {
    for (const path of ["design/design-sheet.tsx", "decisions/decisions-sheet.tsx"])
      expect(read(path)).toContain("props.onDone?.(next, untrack(statusMessage))")
    const workbench = read("surface/workbench.tsx")
    expect(workbench.split("if (said) toast.show(said)")).toHaveLength(3)
    expect(workbench).toContain('<div data-slot="ade-toast" role="status"')
  })
})

describe("rifiniture 3: the recommended choice is marked where it is", () => {
  test("isRecommended matches the recommended name only", () => {
    expect(isRecommended({ option: "B · viola" }, "B · viola")).toBe(true)
    expect(isRecommended({ option: "B · viola" }, "A · verde")).toBe(false)
    expect(isRecommended(undefined, "A · verde")).toBe(false)
  })

  test("the design card marks the recommended variant, and only it", () => {
    const host = designCard()
    const items = [...host.querySelectorAll('[data-slot="design-variant-item"]')]
    expect(items.map((item) => item.getAttribute("data-recommended"))).toEqual([null, "true"])
    expect(items[0]!.querySelector('[data-slot="choice-recommended"]')).toBeNull()
    expect(items[1]!.querySelector('[data-slot="choice-recommended"]')?.textContent).toBe("Consigliata")
  })

  test("the decision card marks the recommended option", () => {
    const host = decisionCard()
    const options = [...host.querySelectorAll('[data-slot="decision-option"]')]
    expect(options.map((option) => Boolean(option.querySelector('[data-slot="choice-recommended"]')))).toEqual([
      true,
      false,
    ])
  })
})
