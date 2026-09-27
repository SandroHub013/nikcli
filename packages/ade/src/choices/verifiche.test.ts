import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createComponent, render } from "solid-js/web"
import { submitControl as decisionControl } from "../decisions/card"
import { answeredStatus, recipientFor } from "../decisions/delivery"
import { parseDecisionLog } from "../decisions/log"
import { foldDecisions } from "../decisions/state"
import { submitControl as designControl } from "../design/card"
import { answeredStatus as designAnsweredStatus, recipientFor as designRecipientFor } from "../design/delivery"
import { parseDesignLog } from "../design/log"
import { foldProposals } from "../design/state"
import { fitScale, roomFor } from "../design/preview-plan"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { afterAnswer, choiceItems, distinctNames } from "./list"

// The cards are `.tsx`: compiled for bun as the hub tests do.
compileSolidJsx()
const { DesignCard } = await import("../design/design-card")
const { DecisionCard } = await import("../decisions/decision-card")

/*
 * Verifiche's proof of «Da scegliere» (ade-team/prove/da-scegliere), the five
 * problems that held the push, each against what the proof measured.
 */
const NOW = new Date("2026-09-27T10:50:00.000Z")
const src = join(import.meta.dir, "..")
const read = (path: string) => readFileSync(join(src, path), "utf8")

const decisionLine = JSON.stringify({
  type: "aperta",
  k: "D1",
  at: NOW.toISOString(),
  by: "Sessione 1 — Terminal",
  fromPane: "p2",
  title: "Prova Verifiche",
  question: "Il riquadro va viola?",
  why: "Il verde si confonde con lo stato pronto.",
  context: "Il riquadro della prova.",
  recommend: { option: "Sì", because: "si distingue" },
  options: [{ label: "Sì" }, { label: "No" }],
})
const proposalLine = JSON.stringify({
  type: "aperta",
  k: "DS1",
  at: NOW.toISOString(),
  by: "Sessione 1 — Terminal",
  fromPane: "p1",
  title: "Colore del riquadro",
  question: "Quale colore per il riquadro?",
  why: "Lo stato pronto è già verde.",
  context: "Tre varianti.",
  recommend: { option: "B · viola", because: "si legge meglio" },
  variants: [
    { name: "A · verde", description: "", preview: "" },
    { name: "B · viola", description: "", preview: "" },
  ],
})
const decision = () => foldDecisions(parseDecisionLog(decisionLine).events, NOW).decisions[0]!
const proposal = () => foldProposals(parseDesignLog(proposalLine).events).proposals[0]!

describe("Verifiche, da-scegliere", () => {
  /*
   * 1. At 1400 px the columns were 420 whatever the pages said: the page of
   * 640 was at 64%, the ones of 420 at 97.6%. A page now has the whole row.
   */
  test("1. a page of 640 in a row of 1374 is at its own size; wider than the row, it is smaller", () => {
    const room = roomFor(1374, 446, 420) // the card: 420 of page, 26 of padding and border
    expect(room).toBe(1348)
    expect(fitScale({ width: 640, height: 300 }, room).scale).toBe(1)
    expect(fitScale({ width: 420, height: 260 }, room).scale).toBe(1)
    expect(fitScale({ width: 1600, height: 300 }, roomFor(800, 426, 400)).scale).toBeCloseTo(774 / 1600)
  })

  test("lint: the variants wrap as flex cards as wide as their pages, not in 420 px columns", () => {
    const css = read("design/design.css")
    expect(css).not.toContain("minmax(min(100%, 420px), 1fr)")
    const row = css.slice(css.indexOf('[data-slot="design-variants"] {'))
    expect(row.slice(0, row.indexOf("}"))).toContain("flex-wrap: wrap")
    expect(read("design/design-preview.tsx")).toContain("roomFor(")
  })

  /*
   * 2. «DS1: B · viola, in coda (nessuna sessione scelta)» for an answer
   * delivered to the pane that asked 0.5 s later: «Risposte a» was empty.
   */
  test("2. the status names the pane that asked, running, whatever «Risposte a» says", () => {
    const candidates = [
      { id: "p1", title: "Sessione 1 — Terminal (1)", running: true },
      { id: "p2", title: "Sessione 1 — Terminal (2)", running: true },
    ]
    const none = { state: "non scelta" } as const
    expect(designAnsweredStatus("DS1", "B · viola", designRecipientFor("p1", candidates, none))).toBe(
      "DS1: B · viola, a Sessione 1 — Terminal (1)",
    )
    const decisionStatus = answeredStatus("D1", "Sì", recipientFor("p2", candidates, none))
    expect(decisionStatus).toContain("Sessione 1 — Terminal (2)")
    expect(decisionStatus).not.toContain("nessuna sessione scelta")
    // With no asker running, what «Risposte a» says, as before.
    expect(designAnsweredStatus("DS1", "B", designRecipientFor(undefined, candidates, none))).toContain(
      "nessuna sessione scelta",
    )
  })

  test("lint: both sheets say the answer's own recipient, not hub.recipient()", () => {
    expect(read("design/design-sheet.tsx")).toContain(
      "showStatus(answeredStatus(proposal.k, label, props.hub.recipientFor(proposal)))",
    )
    expect(read("decisions/decisions-sheet.tsx")).toContain(
      "showStatus(answeredStatus(decision.k, label, props.hub.recipientFor(decision)))",
    )
  })

  /* 3. After the last choice the sheet stayed open on «Nessuna proposta di design aperta». */
  test("3. after the last answer: back to «Da scegliere» while something waits, closed otherwise", () => {
    expect(afterAnswer(1, 3)).toBe("stay")
    expect(afterAnswer(0, 1)).toBe("list")
    expect(afterAnswer(0, 0)).toBe("close")
  })

  test("lint: both sheets leave through onDone, and the workbench reopens the list on «list»", () => {
    for (const path of ["design/design-sheet.tsx", "decisions/decisions-sheet.tsx"]) {
      const sheet = read(path)
      expect(sheet).toContain("afterAnswer(open().length, props.waiting?.() ?? 0)")
      expect(sheet).toContain("setAnswered(true)")
    }
    const workbench = read("surface/workbench.tsx")
    expect(workbench.split('if (next === "list") setChoicesOpen(true)')).toHaveLength(3)
  })

  /* 4. Two Terminals opened one after the other were both «Sessione 1 — Terminal». */
  test("4. two panes of one title are told apart, in the list and in the candidates", () => {
    const names = distinctNames([
      { id: "p1", title: "Sessione 1 — Terminal" },
      { id: "p2", title: "Sessione 1 — Terminal" },
      { id: "p3", title: "Opus" },
    ])
    expect([names.get("p1"), names.get("p2"), names.get("p3")]).toEqual([
      "Sessione 1 — Terminal (1)",
      "Sessione 1 — Terminal (2)",
      "Opus",
    ])
    const items = choiceItems([decision()], [proposal()], names)
    expect(items.map((item) => item.by).sort()).toEqual(["Sessione 1 — Terminal (1)", "Sessione 1 — Terminal (2)"])
    // A pane that is gone: the title the register kept.
    expect(choiceItems([decision()], [], new Map()).map((item) => item.by)).toEqual(["Sessione 1 — Terminal"])
  })

  test("lint: «Risposte a» and «→» take the told-apart names", () => {
    const workbench = read("surface/workbench.tsx")
    expect(workbench.split("title: paneNames().get(pane.id) ?? pane.title")).toHaveLength(3)
  })
})

/* 5. question, why and recommend were in the register and on neither card. */
describe("Verifiche, da-scegliere, 5: the head of the question on the cards", () => {
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

  test("the design card shows the question, why, and the recommended variant over the variants", () => {
    const host = mount(() =>
      createComponent(DesignCard, {
        ...common,
        proposal: proposal(),
        onAgain: () => {},
        control: designControl({
          recipient: { state: "non scelta" },
          sessions: [],
          inline: undefined,
          busy: false,
          label: "Invia",
        }),
      }),
    )
    const brief = host.querySelector('[data-slot="choice-brief"]')
    expect(brief?.querySelector('[data-slot="brief-question"]')?.textContent).toBe("Quale colore per il riquadro?")
    expect(brief?.querySelector('[data-slot="brief-why"]')?.textContent).toContain("Lo stato pronto è già verde.")
    expect(brief?.querySelector('[data-slot="brief-recommend"]')?.textContent).toBe(
      "Consigliata: B · viola, perché si legge meglio",
    )
    const variants = host.querySelector('[data-slot="design-variants"]')!
    expect(brief!.compareDocumentPosition(variants) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test("the decision card shows them over the options", () => {
    const host = mount(() =>
      createComponent(DecisionCard, {
        ...common,
        decision: decision(),
        onDefer: () => {},
        control: decisionControl({
          recipient: { state: "non scelta" },
          sessions: [],
          inline: undefined,
          busy: false,
          label: "Registra",
        }),
      }),
    )
    const brief = host.querySelector('[data-slot="choice-brief"]')
    expect(brief?.querySelector('[data-slot="brief-question"]')?.textContent).toBe("Il riquadro va viola?")
    expect(brief?.querySelector('[data-slot="brief-recommend"]')?.textContent).toBe(
      "Consigliata: Sì, perché si distingue",
    )
    const options = host.querySelector('[data-slot="decision-options"]')!
    expect(brief!.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test("a card without them looks as it did", () => {
    const plain = { ...decision(), question: undefined, why: undefined, recommend: undefined }
    const host = mount(() =>
      createComponent(DecisionCard, {
        ...common,
        decision: plain,
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
    expect(host.querySelector('[data-slot="choice-brief"]')).toBeNull()
  })

  /*
   * notifiche-bassi in integra: this file imported the preview's helpers
   * from `design-preview.tsx` before `compileSolidJsx()` ran, bun compiled
   * the component as React's JSX and kept it, and the hub test's sheet failed
   * with «React is not defined». The helpers are in `preview-plan.ts` now:
   * a card with a page of its own draws the preview in the same process.
   */
  test("a variant with a page draws its preview, in a file that imports the preview's helpers", () => {
    const base = proposal()
    const withPages = {
      ...base,
      variants: base.variants.map((variant, index) => ({ ...variant, preview: `.ade/design/DS1/${index + 1}.html` })),
    }
    const host = mount(() =>
      createComponent(DesignCard, {
        ...common,
        proposal: withPages,
        projectRoot: "C:/p",
        onAgain: () => {},
        control: designControl({
          recipient: { state: "non scelta" },
          sessions: [],
          inline: undefined,
          busy: false,
          label: "Invia",
        }),
      }),
    )
    const previews = host.querySelectorAll('[data-component="design-preview"]')
    expect(previews).toHaveLength(2)
    expect(previews[0]!.getAttribute("data-type")).toBe("html")
  })
})

test("lint: no test imports design-preview.tsx before compileSolidJsx() can run", () => {
  const { readdirSync } = require("node:fs") as typeof import("node:fs")
  const wrong: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (
        entry.name.endsWith(".test.ts") &&
        /^import [^\n]*from "[^"]*design-preview"/m.test(readFileSync(path, "utf8"))
      )
        wrong.push(entry.name)
    }
  }
  walk(src)
  expect(wrong).toEqual([])
})
