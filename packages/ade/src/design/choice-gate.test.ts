import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isAnswerable, isOwnButton, sheetKey } from "./answer"
import { submitControl, submitSteps } from "./card"
import type { RecipientStatus } from "./delivery"
import { createDesignHub } from "./hub"
import type { DesignEvent } from "./log"
import type { DesignRegister } from "./register"
import type { DesignProposal } from "./state"

/*
 * prova 4, item 10: with nothing chosen the sheet's «Registra scelta» was lit and
 * Enter said it records. Nothing is preselected, the button is off until a choice
 * is made, and no press records without one.
 */
const sessions = [{ id: "p1", title: "Master", project: "ragu", running: true }]
const ready: RecipientStatus = { state: "pronta", id: "p1", title: "Master" }
const proposal: DesignProposal = {
  k: "DS-prova",
  title: "Tasto",
  variants: [
    { name: "1 · Scura", description: "", preview: "" },
    { name: "2 · Carta", description: "", preview: "" },
  ],
  recommend: "2 · Carta",
  raisedBy: "fable",
  openedAt: "2026-11-03T10:00:00Z",
  status: "aperta",
  history: [],
}

describe("the Design sheet records only a choice somebody made", () => {
  test("isAnswerable: a pick, or a note (the user's own words are an answer: 6 of 24 in the register are)", () => {
    expect(isAnswerable(undefined, "")).toBe(false)
    expect(isAnswerable(undefined, "   ")).toBe(false)
    expect(isAnswerable(undefined, "non mi convincono")).toBe(true)
    expect(isAnswerable(0, "")).toBe(true)
    expect(isAnswerable([], "")).toBe(false)
    expect(isAnswerable([], "una nota")).toBe(true)
    expect(isAnswerable([1], "")).toBe(true)
  })

  test("a note alone: the button is on and the hub records the words, with no choice invented", async () => {
    const events: DesignEvent[] = []
    const register = {
      path: () => "C:\p\.ade\design.jsonl",
      loaded: () => undefined,
      state: () => undefined,
      error: () => undefined,
      now: () => new Date(),
      refresh: async () => {},
      append: async (event: DesignEvent) => {
        events.push(event)
      },
      watch: () => () => {},
    } as unknown as DesignRegister
    const hub = createDesignHub({
      register,
      recipient: () => ready,
      sessions: () => sessions,
      choose: () => {},
      delivery: () => ({ state: "in coda" }),
      onAnswered: () => {},
    })
    hub.setDraft(proposal.k, { note: "non mi convincono" })
    expect(await hub.submit(proposal, "primary")).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "risposta", words: "non mi convincono" })
    expect(events[0]).not.toHaveProperty("choice")
  })

  test("nothing chosen: the main button and «Registra senza inviare» are off and a press runs nothing", () => {
    const off = submitControl({ recipient: ready, sessions, inline: undefined, busy: false, label: "Registra", chosen: false })
    expect(off.answerable).toBe(false)
    expect(submitSteps(off, sessions, undefined, "primary")).toEqual([])
    const none = submitControl({
      recipient: { state: "non scelta" },
      sessions,
      inline: "p1",
      busy: false,
      label: "Registra",
      chosen: false,
    })
    expect(submitSteps(none, sessions, "p1", "primary")).toEqual([])
    expect(submitSteps(none, sessions, "p1", "record")).toEqual([])
  })

  test("a choice made: the buttons are on and the press answers", () => {
    const on = submitControl({ recipient: ready, sessions, inline: undefined, busy: false, label: "Registra", chosen: true })
    expect(on.answerable).toBe(true)
    expect(submitSteps(on, sessions, undefined, "primary")).toEqual([{ kind: "answer" }])
  })

  test("the hub records nothing for a press with nothing chosen, and the recommended is not preselected", async () => {
    const events: DesignEvent[] = []
    const register = {
      path: () => "C:\\p\\.ade\\design.jsonl",
      loaded: () => undefined,
      state: () => undefined,
      error: () => undefined,
      now: () => new Date(),
      refresh: async () => {},
      append: async (event: DesignEvent) => {
        events.push(event)
      },
      watch: () => () => {},
    } as unknown as DesignRegister
    const hub = createDesignHub({
      register,
      recipient: () => ready,
      sessions: () => sessions,
      choose: () => {},
      delivery: () => ({ state: "in coda" }),
      onAnswered: () => {},
    })
    expect(hub.draft(proposal.k).picked).toBeUndefined()
    expect(await hub.submit(proposal, "primary")).toBe(false)
    expect(await hub.submit(proposal, "record")).toBe(false)
    expect(events).toEqual([])
  })

  test("Enter on a button that is not the answer's own is that button's click, not the answer", () => {
    const button = (slot: string) => ({ tagName: "BUTTON", dataset: { slot } })
    // «Scegli questa» of another variant, «Altro giro», the cross: their own Enter.
    for (const slot of ["variant-choose", "design-ghost", "sheet-close"]) expect([slot, isOwnButton(button(slot))]).toEqual([slot, true])
    // The option just clicked and «Registra scelta» still answer on Enter.
    for (const slot of ["variant-pick-button", "design-submit"]) expect([slot, isOwnButton(button(slot))]).toEqual([slot, false])
    expect(isOwnButton({ tagName: "TEXTAREA", dataset: {} })).toBe(false)
    expect(sheetKey({ key: "Enter" }, 2, false, true, false, true)).toBeUndefined()
    // Ctrl+Enter is chosen on purpose, and still answers.
    expect(sheetKey({ key: "Enter", ctrlKey: true }, 2, false, true, false, true)).toEqual({ kind: "submit" })
    expect(sheetKey({ key: "Enter" }, 2, false, true, false, false)).toEqual({ kind: "submit" })
  })

  test("lint: the card turns the answer buttons off by `answerable`, and «Altro giro» does not wait for a pick", () => {
    const card = readFileSync(join(import.meta.dir, "design-card.tsx"), "utf-8")
    expect(card).toMatch(/data-slot="design-submit"[\s\S]{0,80}disabled=\{props\.control\.disabled \|\| !props\.control\.answerable\}/)
    expect(card).toMatch(/data-action="record"[\s\S]{0,40}disabled=\{props\.busy \|\| !props\.control\.answerable\}/)
    expect(card).toMatch(/data-action="again"[\s\S]{0,40}disabled=\{props\.control\.disabled\}/)
  })
})
