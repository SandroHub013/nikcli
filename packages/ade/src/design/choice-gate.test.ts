import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isAnswerable } from "./answer"
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
  test("isAnswerable: a single question needs a pick, a multi one a box or a note", () => {
    expect(isAnswerable(false, undefined, "")).toBe(false)
    expect(isAnswerable(false, undefined, "una nota")).toBe(false)
    expect(isAnswerable(false, 0, "")).toBe(true)
    expect(isAnswerable(true, [], "")).toBe(false)
    expect(isAnswerable(true, [], "una nota")).toBe(true)
    expect(isAnswerable(true, [1], "")).toBe(true)
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

  test("lint: the card turns the answer buttons off by `answerable`, and «Altro giro» does not wait for a pick", () => {
    const card = readFileSync(join(import.meta.dir, "design-card.tsx"), "utf-8")
    expect(card).toMatch(/data-slot="design-submit"[\s\S]{0,80}disabled=\{props\.control\.disabled \|\| !props\.control\.answerable\}/)
    expect(card).toMatch(/data-action="record"[\s\S]{0,40}disabled=\{props\.busy \|\| !props\.control\.answerable\}/)
    expect(card).toMatch(/data-action="again"[\s\S]{0,40}disabled=\{props\.control\.disabled\}/)
  })
})
