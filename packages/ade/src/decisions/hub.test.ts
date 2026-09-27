import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createDecisionsHub } from "./hub"
import { isFormField, sheetKey } from "./answer"
import { t } from "../i18n"
import type { DecisionEvent } from "./log"
import { createDecisionsRegister } from "./register"
import type { Decision } from "./state"
import type { DecisionsIo } from "./store"

if (typeof document === "undefined") {
  GlobalRegistrator.register()
}
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
// A sheet is a portal with a focus trap: find it in `document`, and unmount it with the dispose `render` returns (disposing createRoot's leaves it, and its trap, on the next tests).
const { DecisionsSheet } = await import("./decisions-sheet")
const { DecisionsPane } = await import("./decisions-pane")

const opened = (k: string) =>
  `${JSON.stringify({ type: "aperta", k, at: "2026-09-15T10:00:00.000Z", by: "Master", title: `T ${k}`, options: [{ label: "A" }, { label: "B" }] })}\n`

function memory(initial: string) {
  const files = new Map([["/p/.ade/decisions.jsonl", initial]])
  const io: DecisionsIo = {
    readTextFile: async (path) => ({ text: files.get(path) ?? "", truncated: false }),
    writeTextFile: async (path, contents) => {
      files.set(path, contents)
      return null
    },
    appendTextFile: async (path, text) => {
      files.set(path, (files.get(path) ?? "") + text)
      return null
    },
  }
  return { io, files }
}

describe("the register and the hub", () => {
  test("an answer is written from the draft, the draft is cleared and the message is queued", async () => {
    const { io, files } = memory(opened("D1"))
    const answered: DecisionEvent[] = []
    await createRoot(async (dispose) => {
      const register = createDecisionsRegister({ path: () => "/p/.ade/decisions.jsonl", io: async () => io })
      const hub = createDecisionsHub({
        register,
        recipient: () => ({ state: "non scelta" }),
        sessions: () => [],
        choose: () => {},
        delivery: () => ({ state: "in coda" }),
        onAnswered: (_, event) => void answered.push(event),
      })
      await register.refresh()
      const decision = register.state()!.decisions[0] as Decision

      expect(await hub.answer(decision)).toBe(false)
      expect(hub.problem("D1")).toBe("scegli un'opzione o scrivi la risposta")

      hub.setDraft("D1", { picked: 1, note: "subito" })
      expect(hub.problem("D1")).toBeUndefined()
      expect(await hub.answer(decision)).toBe(true)
      expect(hub.draft("D1")).toEqual({ note: "" })
      expect(register.state()!.decisions[0]!.status).toBe("risposta")
      expect(answered.map((event) => (event as { words: string }).words)).toEqual(["B — subito"])
      expect(files.get("/p/.ade/decisions.jsonl")!.trim().split("\n")).toHaveLength(2)

      // A second answer on top is refused by the register and shown on the card.
      hub.setDraft("D1", { picked: 0, note: "" })
      expect(await hub.answer(decision)).toBe(false)
      expect(hub.problem("D1")).toBe("D1 ha già una risposta: prima va riaperta")
      dispose()
    })
  })

  test("a read that finishes after the project changed is dropped", async () => {
    const { io } = memory(opened("D1"))
    let path = "/p/.ade/decisions.jsonl"
    const slow: DecisionsIo = {
      ...io,
      readTextFile: async (file, max) => {
        path = "/q/.ade/decisions.jsonl"
        return io.readTextFile(file, max)
      },
    }
    await createRoot(async (dispose) => {
      const register = createDecisionsRegister({ path: () => path, io: async () => slow })
      await register.refresh()
      expect(register.loaded()).toBeUndefined()
      dispose()
    })
  })
})

describe("Enter with nobody to receive the answer (audit 0.7.7, MEDIO 7)", () => {
  test("the window says to choose who receives, instead of doing nothing", async () => {
    const { io } = memory(opened("D1"))
    await createRoot(async (dispose) => {
      const register = createDecisionsRegister({ path: () => "/p/.ade/decisions.jsonl", io: async () => io })
      const hub = createDecisionsHub({ register, recipient: () => ({ state: "non scelta" }), sessions: () => [], choose: () => {}, delivery: () => ({ state: "in coda" }), onAnswered: () => {} })
      await register.refresh()
      const decision = register.state()!.decisions[0] as Decision
      hub.setDraft("D1", { picked: 0, note: "" })

      expect(await hub.submit(decision, "primary")).toBe(false)
      expect(hub.problem("D1")).toBe(t("decisions.sheet.needRecipient"))
      // A session picked in the select: the note goes.
      hub.setInlineRecipient("p1")
      expect(hub.problem("D1")).toBeUndefined()
      dispose()
    })
  })
})

describe("keys aimed at a field of the window (audit 0.7.7, MEDIO 7)", () => {
  test("arrows, digits and Enter on the «who receives» select stay the select's; Escape still closes", () => {
    const select = { tagName: "SELECT" }
    expect(isFormField(select)).toBe(true)
    for (const key of ["ArrowRight", "ArrowLeft", "1", "Enter"]) expect(sheetKey({ key }, 2, false, true, isFormField(select))).toBeUndefined()
    expect(sheetKey({ key: "Escape" }, 2, false, true, true)).toEqual({ kind: "close" })
  })

  test("on the window itself they work as before", () => {
    expect(isFormField({ tagName: "DIV" })).toBe(false)
    expect(sheetKey({ key: "1" }, 2, false, false, false)).toEqual({ kind: "pick", index: 0 })
    expect(sheetKey({ key: "Enter" }, 2, false, true, false)).toEqual({ kind: "submit" })
  })
})

describe("card stability (R0, ALTO 1)", () => {
  test("a tick or a new event of another decision reuses the same Decision object reference", async () => {
    const { io, files } = memory(opened("D1"))
    await createRoot(async (dispose) => {
      const register = createDecisionsRegister({ path: () => "/p/.ade/decisions.jsonl", io: async () => io })
      await register.refresh()
      const d1Before = register.state()!.decisions[0]

      // A tick occurs
      await register.tick()
      const d1AfterTick = register.state()!.decisions[0]
      expect(d1AfterTick).toBe(d1Before)

      // Another decision D2 is opened in the file
      files.set("/p/.ade/decisions.jsonl", files.get("/p/.ade/decisions.jsonl")! + opened("D2"))
      await register.refresh()

      const d1AfterD2 = register.state()!.decisions.find((d) => d.k === "D1")
      expect(d1AfterD2).toBe(d1Before)
      dispose()
    })
  })

  test("with a note in progress and focus inside, a tick or a new event for another decision does not unmount the card", async () => {
    const { io, files } = memory(opened("D1"))
    const host = document.createElement("div")
    document.body.append(host)

    let register!: ReturnType<typeof createDecisionsRegister>
    let hub!: ReturnType<typeof createDecisionsHub>

    // `render` has its own root: disposing createRoot's would leave the sheet, and its focus trap, mounted.
    let unrender!: () => void
    const dispose = createRoot((dispose) => {
      register = createDecisionsRegister({ path: () => "/p/.ade/decisions.jsonl", io: async () => io })
      hub = createDecisionsHub({
        register,
        recipient: () => ({ state: "non scelta" }),
        sessions: () => [],
        choose: () => {},
        delivery: () => ({ state: "in coda" }),
        onAnswered: () => {},
      })
      unrender = render(
        () =>
          createComponent(DecisionsSheet, {
            hub,
            onClose: () => {},
            onOpenPanel: () => {},
          }),
        host,
      )
      return dispose
    })

    await register.refresh()

    // Find the card and textarea
    // The sheet is a portal (kobalte-overlay): it renders into the shell, not into `host`.
    const cardBefore = document.querySelector('[data-slot="decision-card"]') as HTMLElement
    const textarea = document.querySelector('[data-slot="decision-note"]') as HTMLTextAreaElement
    expect(cardBefore).not.toBeNull()
    expect(textarea).not.toBeNull()

    // Type a note and focus the textarea
    hub.setDraft("D1", { note: "nota a metà" })
    textarea.focus()
    expect(document.activeElement).toBe(textarea)

    // A tick occurs (e.g. minute turn)
    await register.tick()

    // Card must not be unmounted and focus must stay in the note
    const cardAfterTick = document.querySelector('[data-slot="decision-card"]')
    expect(cardAfterTick).toBe(cardBefore)
    expect(document.activeElement).toBe(textarea)

    // Another decision D2 is added to the register
    files.set("/p/.ade/decisions.jsonl", files.get("/p/.ade/decisions.jsonl")! + opened("D2"))
    await register.refresh()

    // Card must still be the exact same element and focus must still be preserved
    const cardAfterD2 = document.querySelector('[data-slot="decision-card"]')
    expect(cardAfterD2).toBe(cardBefore)
    expect(document.activeElement).toBe(textarea)

    unrender()
    dispose()
    host.remove()
  })

  test("with a note in progress and focus inside DecisionsPane, a tick or a new event for another decision does not unmount the card", async () => {
    const { io, files } = memory(opened("D1"))
    const host = document.createElement("div")
    document.body.append(host)

    let register!: ReturnType<typeof createDecisionsRegister>
    let hub!: ReturnType<typeof createDecisionsHub>

    const dispose = createRoot((dispose) => {
      register = createDecisionsRegister({ path: () => "/p/.ade/decisions.jsonl", io: async () => io })
      hub = createDecisionsHub({
        register,
        recipient: () => ({ state: "non scelta" }),
        sessions: () => [],
        choose: () => {},
        delivery: () => ({ state: "in coda" }),
        onAnswered: () => {},
      })
      render(
        () =>
          createComponent(DecisionsPane, {
            hub,
            focused: true,
          }),
        host,
      )
      return dispose
    })

    await register.refresh()

    const cardBefore = host.querySelector('[data-slot="decision-card"]') as HTMLElement
    const textarea = host.querySelector('[data-slot="decision-note"]') as HTMLTextAreaElement
    expect(cardBefore).not.toBeNull()
    expect(textarea).not.toBeNull()

    hub.setDraft("D1", { note: "nota nel pannello" })
    textarea.focus()
    expect(document.activeElement).toBe(textarea)

    await register.tick()
    expect(host.querySelector('[data-slot="decision-card"]')).toBe(cardBefore)
    expect(document.activeElement).toBe(textarea)

    files.set("/p/.ade/decisions.jsonl", files.get("/p/.ade/decisions.jsonl")! + opened("D2"))
    await register.refresh()

    expect(host.querySelector('[data-slot="decision-card"]')).toBe(cardBefore)
    expect(document.activeElement).toBe(textarea)

    dispose()
    host.remove()
  })
})

describe("reopening an answered decision (ALTO 5)", () => {
  const answeredFile = (k: string) =>
    `${JSON.stringify({ type: "aperta", k, at: "2026-09-15T10:00:00.000Z", by: "Master", title: `T ${k}`, options: [{ label: "A" }, { label: "B" }] })}\n` +
    `${JSON.stringify({ type: "risposta", k, at: "2026-09-15T10:05:00.000Z", by: "utente", choice: "B", words: "B" })}\n`

  test("hub.reopen invokes onReopened when delivery is consegnata, but not when in coda", async () => {
    const { io } = memory(answeredFile("D1"))
    let reopenedCount = 0
    let lastDeliveredTo: string | undefined
    let delivered = false

    await createRoot(async (dispose) => {
      const register = createDecisionsRegister({ path: () => "/p/.ade/decisions.jsonl", io: async () => io })
      const hub = createDecisionsHub({
        register,
        recipient: () => ({ state: "pronta", id: "p1", title: "Master" }),
        sessions: () => [{ id: "p1", title: "Master", running: true }],
        choose: () => {},
        delivery: () => (delivered ? { state: "consegnata", to: "Master", at: 123 } : { state: "in coda" }),
        onAnswered: () => {},
        onReopened: (_decision, deliveredTo) => {
          reopenedCount++
          lastDeliveredTo = deliveredTo
        },
      })
      await register.refresh()
      const decision = register.state()!.decisions[0] as Decision

      // First test: not delivered yet
      delivered = false
      await hub.reopen(decision)
      expect(reopenedCount).toBe(0)

      // Refresh to see reopened state, answer again
      hub.setDraft("D1", { picked: 1, note: "" })
      await hub.answer(decision)

      // Now marked delivered
      delivered = true
      await hub.reopen(decision)
      expect(reopenedCount).toBe(1)
      expect(lastDeliveredTo).toBe("Master")
      dispose()
    })
  })

  test("DecisionsPane shows inline confirmation with recipient info when delivered", async () => {
    const { io } = memory(answeredFile("D1"))
    const host = document.createElement("div")
    document.body.append(host)

    let register!: ReturnType<typeof createDecisionsRegister>
    let hub!: ReturnType<typeof createDecisionsHub>
    let reopened = false

    const dispose = createRoot((dispose) => {
      register = createDecisionsRegister({ path: () => "/p/.ade/decisions.jsonl", io: async () => io })
      hub = createDecisionsHub({
        register,
        recipient: () => ({ state: "pronta", id: "p1", title: "Master" }),
        sessions: () => [{ id: "p1", title: "Master", running: true }],
        choose: () => {},
        delivery: () => ({ state: "consegnata", to: "Master", at: Date.now() }),
        onAnswered: () => {},
        onReopened: () => {
          reopened = true
        },
      })
      render(
        () =>
          createComponent(DecisionsPane, {
            hub,
            focused: true,
          }),
        host,
      )
      return dispose
    })

    await register.refresh()

    // Find the «Cambia risposta» button
    const changeBtn = host.querySelector('[data-slot="decision-actions"] button[data-slot="decision-ghost"]') as HTMLButtonElement
    expect(changeBtn).not.toBeNull()
    expect(changeBtn.textContent).toBe(t("decisions.change"))

    // Click «Cambia risposta»
    changeBtn.click()

    // Inline confirmation must now appear
    const alert = host.querySelector('[data-slot="decision-actions"][role="alert"]') as HTMLElement
    expect(alert).not.toBeNull()
    expect(alert.textContent).toContain("Riaprire D1?")
    expect(alert.textContent).toContain("Master ha già la risposta B")

    const cancelBtn = alert.querySelector('button[data-slot="decision-ghost"]') as HTMLButtonElement
    const confirmBtn = alert.querySelector('button[data-slot="decision-submit"]') as HTMLButtonElement
    expect(cancelBtn.textContent).toBe(t("new.cancel"))
    expect(confirmBtn.textContent).toBe(t("decisions.reopen"))

    // Click cancel: reverts to normal actions without reopening
    cancelBtn.click()
    expect(host.querySelector('[data-slot="decision-actions"][role="alert"]')).toBeNull()
    expect(reopened).toBe(false)

    // Open confirmation again and confirm
    const changeBtnAgain = host.querySelector('[data-slot="decision-actions"] button[data-slot="decision-ghost"]') as HTMLButtonElement
    changeBtnAgain.click()
    const confirmBtnAgain = host.querySelector('[data-slot="decision-actions"][role="alert"] button[data-slot="decision-submit"]') as HTMLButtonElement
    confirmBtnAgain.click()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(reopened).toBe(true)

    dispose()
    host.remove()
  })

  test("DecisionsPane shows simple inline confirmation when not yet delivered", async () => {
    const { io } = memory(answeredFile("D1"))
    const host = document.createElement("div")
    document.body.append(host)

    let register!: ReturnType<typeof createDecisionsRegister>
    let hub!: ReturnType<typeof createDecisionsHub>

    const dispose = createRoot((dispose) => {
      register = createDecisionsRegister({ path: () => "/p/.ade/decisions.jsonl", io: async () => io })
      hub = createDecisionsHub({
        register,
        recipient: () => ({ state: "non attiva", id: "p1", title: "Master" }),
        sessions: () => [],
        choose: () => {},
        delivery: () => ({ state: "in coda" }),
        onAnswered: () => {},
      })
      render(
        () =>
          createComponent(DecisionsPane, {
            hub,
            focused: true,
          }),
        host,
      )
      return dispose
    })

    await register.refresh()

    const changeBtn = host.querySelector('[data-slot="decision-actions"] button[data-slot="decision-ghost"]') as HTMLButtonElement
    changeBtn.click()

    const alert = host.querySelector('[data-slot="decision-actions"][role="alert"]') as HTMLElement
    expect(alert).not.toBeNull()
    expect(alert.textContent).toContain("Riaprire D1?")
    expect(alert.textContent).not.toContain("ha già la risposta")

    dispose()
    host.remove()
  })
})

describe("sheet status line on submit (MEDIO 6)", () => {
  test("submitting an answer displays the status line in the sheet footer", async () => {
    const { io } = memory(opened("D1"))
    const host = document.createElement("div")
    document.body.append(host)

    let register!: ReturnType<typeof createDecisionsRegister>
    let hub!: ReturnType<typeof createDecisionsHub>

    // `render` has its own root: disposing createRoot's would leave the sheet, and its focus trap, mounted.
    let unrender!: () => void
    const dispose = createRoot((dispose) => {
      register = createDecisionsRegister({ path: () => "/p/.ade/decisions.jsonl", io: async () => io })
      hub = createDecisionsHub({
        register,
        recipient: () => ({ state: "pronta", id: "p1", title: "Master" }),
        sessions: () => [{ id: "p1", title: "Master", running: true }],
        choose: () => {},
        delivery: () => ({ state: "in coda" }),
        onAnswered: () => {},
      })
      unrender = render(
        () =>
          createComponent(DecisionsSheet, {
            hub,
            onClose: () => {},
            onOpenPanel: () => {},
          }),
        host,
      )
      return dispose
    })

    await register.refresh()

    // Pick option B (index 1)
    hub.setDraft("D1", { picked: 1, note: "" })

    // Submit
    const submitBtn = document.querySelector('[data-slot="decision-submit"]') as HTMLButtonElement
    expect(submitBtn).not.toBeNull()
    submitBtn.click()

    // Wait a tick for async submit and status update
    await new Promise((resolve) => setTimeout(resolve, 50))

    const statusEl = document.querySelector('[data-slot="sheet-foot"] [data-slot="sheet-status"]')
    expect(statusEl).not.toBeNull()
    expect(statusEl?.textContent).toBe("D1: B, a Master")
    expect(statusEl?.getAttribute("role")).toBe("status")
    expect(statusEl?.getAttribute("aria-live")).toBe("polite")

    unrender()
    dispose()
    host.remove()
  })
})
