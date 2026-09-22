import { describe, expect, test } from "bun:test"
import { enterReady, togglePick } from "./answer"
import { queuedBadge, submitControl } from "./card"
import { createDecisionsHub } from "./hub"
import type { DecisionsRegister } from "./register"
import type { RecipientStatus } from "./delivery"
import type { Decision } from "./state"
import { answerEvent, countLabel, deferFromInput, deferPresets, formatDay, sheetKey } from "./answer"
import { deliveryLine, deliveryState, enqueue, markDelivered, parseOutbox, pendingFor, pruneOutbox, chooseRecipient, parseRecipients, recipientChange, recipientOptions, resolveRecipient } from "./delivery"
import type { DecisionEvent } from "./log"
import { foldDecisions } from "./state"

const decision = { k: "D21", options: [{ label: "A · Rifinitura" }, { label: "B · Estensioni" }] }

describe("the window's keys", () => {
  test("digits pick, Enter records a choice, Esc closes, arrows move", () => {
    expect(sheetKey({ key: "2" }, 2, false, false)).toEqual({ kind: "pick", index: 1 })
    expect(sheetKey({ key: "3" }, 2, false, false)).toBeUndefined()
    expect(sheetKey({ key: "Enter" }, 2, false, true)).toEqual({ kind: "submit" })
    expect(sheetKey({ key: "Escape" }, 2, true, false)).toEqual({ kind: "close" })
    expect(sheetKey({ key: "ArrowRight" }, 2, false, false)).toEqual({ kind: "next" })
  })

  test("a stray Enter with nothing chosen records nothing", () => {
    expect(sheetKey({ key: "Enter" }, 2, false, false)).toEqual({ kind: "need-choice" })
    expect(sheetKey({ key: "Enter" }, 0, false, false)).toEqual({ kind: "need-choice" })
  })

  test("in the note, keys are typing; only Ctrl+Enter records", () => {
    expect(sheetKey({ key: "2" }, 2, true, false)).toBeUndefined()
    expect(sheetKey({ key: "Enter" }, 2, true, true)).toBeUndefined()
    expect(sheetKey({ key: "ArrowLeft" }, 2, true, false)).toBeUndefined()
    expect(sheetKey({ key: "Enter", ctrlKey: true }, 2, true, false)).toEqual({ kind: "submit" })
  })
})

describe("an answer", () => {
  const at = new Date("2026-09-15T15:21:00Z")

  test("carries the option and the note together as the user's words", () => {
    expect(answerEvent(decision, 1, "  ma senza il globale ", at)).toEqual({
      type: "risposta",
      k: "D21",
      at: at.toISOString(),
      by: "utente",
      choice: "B · Estensioni",
      note: "ma senza il globale",
      words: "B · Estensioni — ma senza il globale",
    })
  })

  test("can be written words alone, but not nothing", () => {
    expect(answerEvent(decision, undefined, "nessuna delle due", at)).toMatchObject({ words: "nessuna delle due" })
    expect(answerEvent(decision, undefined, "  ", at)).toBe("scegli un'opzione o scrivi la risposta")
  })
})

describe("dates", () => {
  test("presets are the start of a later local day", () => {
    const now = new Date(2026, 8, 15, 17, 30) // a Tuesday
    const [tomorrow, three, monday] = deferPresets(now)
    expect(new Date(tomorrow!.until)).toEqual(new Date(2026, 8, 16))
    expect(new Date(three!.until)).toEqual(new Date(2026, 8, 18))
    expect(new Date(monday!.until)).toEqual(new Date(2026, 8, 21))
    expect(new Date(deferPresets(new Date(2026, 8, 21, 9))[2]!.until)).toEqual(new Date(2026, 8, 28))
  })

  test("a typed date must be in the future", () => {
    const now = new Date(2026, 8, 15, 17, 30)
    expect(deferFromInput("2026-09-20", now)).toBe(new Date(2026, 8, 20).toISOString())
    expect(deferFromInput("2026-09-15", now)).toBeUndefined()
    expect(deferFromInput("20/09/2026", now)).toBeUndefined()
  })

  test("days read the way people say them", () => {
    const now = new Date(2026, 8, 15, 17, 30)
    expect(formatDay(new Date(2026, 8, 15, 9).toISOString(), now)).toBe("oggi")
    expect(formatDay(new Date(2026, 8, 16).toISOString(), now)).toBe("domani")
    expect(formatDay(new Date(2026, 8, 20).toISOString(), now)).toBe("20 set")
    expect(formatDay(new Date(2027, 0, 4).toISOString(), now)).toBe("4 gen 2027")
    expect(countLabel(1)).toBe("1 decisione")
    expect(countLabel(3)).toBe("3 decisioni")
  })
})

describe("who hears about an answer", () => {
  const panes = [
    { id: "a", title: "Dario", project: "nikcli", running: true },
    { id: "b", title: "Master", project: "altro", running: true },
    { id: "c", title: "master · S18", project: "nikcli", running: false },
    { id: "d", title: "Master 2", project: "nikcli", running: true },
  ]

  test("only the chosen session, whatever it is called; nobody chosen is nobody", () => {
    // No title is special: a running "Master" gets nothing unless chosen.
    expect(resolveRecipient(panes, undefined)).toEqual({ state: "non scelta" })
    expect(resolveRecipient(panes, { id: "a", title: "Dario" })).toEqual({ state: "pronta", id: "a", title: "Dario" })
    // Another project's session is as good as one here.
    expect(resolveRecipient(panes, { id: "b", title: "vecchio nome" })).toEqual({ state: "pronta", id: "b", title: "Master" })
    expect(resolveRecipient(panes, { id: "c", title: "master · S18" })).toEqual({ state: "non attiva", id: "c", title: "master · S18" })
    expect(resolveRecipient(panes, { id: "z", title: "Chiusa" })).toEqual({ state: "non attiva", id: "z", title: "Chiusa" })
  })

  test("moving through the selector sends nothing queued without a confirmation", () => {
    expect(recipientChange(undefined, "a", 2)).toBe("conferma")
    expect(recipientChange("a", "b", 1)).toBe("conferma")
    expect(recipientChange(undefined, "a", 0)).toBe("applica")
    expect(recipientChange("a", undefined, 3)).toBe("applica")
    expect(recipientChange("a", "a", 3)).toBe("nessuna")
    expect(recipientChange(undefined, undefined, 3)).toBe("nessuna")
  })

  test("the selector shows the real recipient, not its first entry", () => {
    const shown = (options: { value: string; selected: boolean }[]) => options.filter((option) => option.selected).map((option) => option.value)
    // After "Consegna": the recipient is chosen and nothing is pending.
    expect(shown(recipientOptions(panes, { state: "pronta", id: "b", title: "Master" }))).toEqual(["b"])
    // Rebuilt from fresh session objects, as a delivery note causes: still "b".
    expect(shown(recipientOptions(panes.map((pane) => ({ ...pane })), { state: "pronta", id: "b", title: "Master" }))).toEqual(["b"])
    expect(shown(recipientOptions(panes, { state: "non scelta" }))).toEqual([""])
    // A pick waiting for confirmation is what the select shows meanwhile.
    expect(shown(recipientOptions(panes, { state: "non scelta" }, "a"))).toEqual(["a"])
    const closed = recipientOptions(panes, { state: "non attiva", id: "z", title: "Vecchia" })
    expect(closed.at(-1)).toEqual({ value: "z", label: "Vecchia (chiusa)", selected: true })
    expect(recipientOptions(panes, { state: "non scelta" }).map((option) => option.label)).toContain("master · S18 · nikcli (ferma)")
  })

  test("the choice is kept per project and survives a bad value", () => {
    let all = chooseRecipient({}, "/p/.ade/decisions.jsonl", { id: "a", title: "Dario" })
    all = chooseRecipient(all, "/q/.ade/decisions.jsonl", { id: "b", title: "Coordina" })
    expect(parseRecipients(JSON.stringify(all))).toEqual(all)
    expect(chooseRecipient(all, "/p/.ade/decisions.jsonl", undefined)).toEqual({ "/q/.ade/decisions.jsonl": { id: "b", title: "Coordina" } })
    expect(parseRecipients("{rotto")).toEqual({})
    expect(parseRecipients(JSON.stringify({ x: { id: 3 }, y: { id: "d", title: "T" } }))).toEqual({ y: { id: "d", title: "T" } })
  })

  test("the line starts with who it is from and the verb", () => {
    const { decisions } = foldDecisions([
      { type: "aperta", k: "D21", at: "2026-09-15T15:00:00Z", by: "Dario", title: "Pagina Plugin" },
      { type: "risposta", k: "D21", at: "2026-09-15T15:21:00Z", by: "utente", words: "la B" },
    ] as DecisionEvent[])
    expect(deliveryLine(decisions[0]!)).toBe('[Decisione da utente] risolta [k=D21] Pagina Plugin — parole: "la B"')
  })
})

describe("the outbox", () => {
  const path = "/p/.ade/decisions.jsonl"
  const events: DecisionEvent[] = [
    { type: "aperta", k: "D1", at: "2026-09-15T10:00:00Z", by: "Master", title: "Uno" },
    { type: "risposta", k: "D1", at: "2026-09-15T10:05:00Z", by: "utente", words: "sì" },
    { type: "aperta", k: "D2", at: "2026-09-15T10:00:00Z", by: "Master", title: "Due" },
  ]

  test("queued, delivered, and forgotten once closed or changed", () => {
    let outbox = enqueue([], { path, k: "D1", answeredAt: "2026-09-15T10:05:00Z", queuedAt: 1 })
    const { decisions } = foldDecisions(events)
    expect(deliveryState(outbox, path, decisions[0]!)).toEqual({ state: "in coda" })
    expect(pendingFor(outbox, path)).toHaveLength(1)

    outbox = markDelivered(outbox, outbox[0]!, "Master", 99)
    expect(deliveryState(outbox, path, decisions[0]!)).toEqual({ state: "consegnata", to: "Master", at: 99 })
    expect(pendingFor(outbox, path)).toHaveLength(0)
    expect(parseOutbox(JSON.stringify(outbox))).toEqual(outbox)

    const closed = foldDecisions([...events, { type: "chiusa", k: "D1", at: "2026-09-15T11:00:00Z", by: "Master" }]).decisions
    expect(pruneOutbox(outbox, path, closed)).toEqual([])
    const other = enqueue([], { path: "/q/.ade/decisions.jsonl", k: "D1", answeredAt: "x", queuedAt: 1 })
    expect(pruneOutbox(other, path, closed)).toEqual(other)
  })

  test("an answer written outside ADE is not sent anywhere", () => {
    const { decisions } = foldDecisions(events)
    expect(deliveryState([], path, decisions[0]!)).toEqual({ state: "fuori da ADE" })
    expect(parseOutbox("{rotto")).toEqual([])
  })
})

/*
 * The card's answer buttons (S75 point 1). The spec asks for these as UI
 * tests; Solid components are not rendered in `bun test` on this repo, so the
 * card only draws `submitControl` and the hub runs `submitSteps`, and the
 * same scenarios are asserted here against those functions.
 */
describe("answering with nobody to receive", () => {
  const sessions = [
    { id: "p1", title: "Master", project: "nikcli", running: true },
    { id: "p2", title: "fable", project: "nikcli", running: false },
  ]
  const decision: Decision = {
    k: "D30",
    title: "Dove va il registro",
    context: "",
    options: [{ label: "A" }, { label: "B" }],
    unlocks: "",
    order: 0,
    raisedBy: "fable",
    openedAt: "2026-09-23T10:00:00Z",
    status: "aperta",
    history: [],
  } as unknown as Decision

  const setup = (recipient: () => RecipientStatus) => {
    const calls: string[] = []
    const register = {
      path: () => "C:\p\.ade\decisions.jsonl",
      loaded: () => undefined,
      state: () => undefined,
      error: () => undefined,
      now: () => new Date(),
      refresh: async () => {},
      append: async (event: DecisionEvent) => {
        calls.push(`answer:${event.type}`)
      },
      watch: () => () => {},
    } as unknown as DecisionsRegister
    const hub = createDecisionsHub({
      register,
      recipient,
      sessions: () => sessions,
      choose: (id) => calls.push(`choose:${id}`),
      delivery: () => ({ state: "in coda" }),
      onAnswered: () => {},
    })
    hub.setDraft(decision.k, { picked: 1, note: "" })
    const control = () =>
      submitControl({ recipient: recipient(), sessions, inline: hub.inlineRecipient(), busy: false, label: "Registra" })
    return { hub, calls, control }
  }

  test("the card shows the inline select, «Scegli e invia» disabled, and Enter records nothing", async () => {
    const { hub, calls, control } = setup(() => ({ state: "non scelta" }))
    expect(control().options?.map((option) => option.value)).toEqual(["", "p1", "p2"])
    expect(control().label).toBe("Scegli e invia")
    expect(control().disabled).toBe(true)
    expect(control().recordOnly).toBe(true)
    // Enter, with a variant picked: the sheet turns it into the main button's press.
    expect(sheetKey({ key: "Enter" }, 2, false, true)).toEqual({ kind: "submit" })
    expect(await hub.submit(decision, "primary")).toBe(false)
    expect(sheetKey({ key: "Enter", ctrlKey: true }, 2, true, true)).toEqual({ kind: "submit" })
    expect(await hub.submit(decision, "primary")).toBe(false)
    expect(calls).toEqual([])
  })

  test("a stopped session picked inline does not enable it", () => {
    const { hub, control } = setup(() => ({ state: "non scelta" }))
    hub.setInlineRecipient("p2")
    expect(control().disabled).toBe(true)
  })

  test("with a running session picked, the button chooses it and then answers, in that order", async () => {
    const { hub, calls, control } = setup(() => ({ state: "non scelta" }))
    hub.setInlineRecipient("p1")
    expect(control().disabled).toBe(false)
    expect(control().options?.find((option) => option.selected)?.value).toBe("p1")
    expect(await hub.submit(decision, "primary")).toBe(true)
    expect(calls).toEqual(["choose:p1", "answer:risposta"])
  })

  test("«Registra senza inviare» answers without choosing", async () => {
    const { hub, calls } = setup(() => ({ state: "non attiva", id: "p2", title: "fable" }))
    expect(await hub.submit(decision, "record")).toBe(true)
    expect(calls).toEqual(["answer:risposta"])
  })

  test("with a ready recipient the card is today's: no select, no second button", async () => {
    const { hub, calls, control } = setup(() => ({ state: "pronta", id: "p1", title: "Master" }))
    expect(control()).toEqual({ gate: "invia", label: "Registra", disabled: false, recordOnly: false })
    expect(await hub.submit(decision, "primary")).toBe(true)
    expect(calls).toEqual(["answer:risposta"])
  })

  test("the bar button says how many answers wait", () => {
    expect(queuedBadge(0)).toBeUndefined()
    expect(queuedBadge(2)).toBe("· 2 in coda")
  })
})

/*
 * Multiple answers (S75 point 6). As for point 1, the spec's UI test is run
 * against the functions the card and the sheet use: `sheetKey` for the key,
 * `togglePick` for the box, `enterReady` for Enter, the hub for the answer.
 */
describe("a multiple question", () => {
  const multi = { k: "M1", options: [{ label: "opzione 1" }, { label: "opzione 2" }, { label: "opzione 3" }], multi: true as const }

  test("answerEvent: boxes 3 and 1 give choices in the options' order, and the words", () => {
    const at = new Date("2026-09-23T10:00:00Z")
    expect(answerEvent(multi, [2, 0], "", at)).toMatchObject({ choices: ["opzione 1", "opzione 3"], words: "opzione 1 + opzione 3" })
    expect(answerEvent(multi, [2, 0], "ma piano", at)).toMatchObject({ words: "opzione 1 + opzione 3 — ma piano", note: "ma piano" })
    expect(answerEvent(multi, [], "", at)).toBeTypeOf("string")
    expect((answerEvent(multi, [0], "", at) as { choice?: string }).choice).toBeUndefined()
  })

  test("«1» then «3» tick two boxes, «1» again unticks the first, and Enter records choices with option 3 only", async () => {
    const appended: DecisionEvent[] = []
    const register = {
      path: () => "C:\\p\\.ade\\decisions.jsonl",
      loaded: () => undefined,
      state: () => undefined,
      error: () => undefined,
      now: () => new Date(),
      refresh: async () => {},
      append: async (event: DecisionEvent) => {
        appended.push(event)
      },
      watch: () => () => {},
    } as unknown as DecisionsRegister
    const hub = createDecisionsHub({
      register,
      recipient: () => ({ state: "pronta", id: "p1", title: "Master" }),
      sessions: () => [{ id: "p1", title: "Master", running: true }],
      choose: () => {},
      delivery: () => ({ state: "in coda" }),
      onAnswered: () => {},
    })
    const decision = { ...multi, title: "Quali", raisedBy: "fable", openedAt: "2026-09-23T10:00:00Z", status: "aperta", history: [] } as never
    const press = (key: string) => {
      const draft = hub.draft("M1")
      const action = sheetKey({ key }, 3, false, enterReady(true, draft.picked, draft.note, true))
      if (action?.kind === "pick") hub.setDraft("M1", { ...draft, picked: togglePick(draft.picked, action.index, true) })
      return action
    }
    press("1")
    press("3")
    expect(hub.draft("M1").picked).toEqual([0, 2])
    press("1")
    expect(hub.draft("M1").picked).toEqual([2])
    expect(press("Enter")).toEqual({ kind: "submit" })
    expect(await hub.submit(decision, "primary")).toBe(true)
    expect(appended[0]).toMatchObject({ choices: ["opzione 3"], words: "opzione 3" })
  })

  test("Enter with no box and no note asks, as today", () => {
    expect(sheetKey({ key: "Enter" }, 3, false, enterReady(true, [], "", true))).toEqual({ kind: "need-choice" })
    expect(sheetKey({ key: "Enter" }, 3, false, enterReady(true, [], "solo nota", true))).toEqual({ kind: "submit" })
  })

  test("a single question keeps today's picking", () => {
    expect(togglePick(0, 2, false)).toBe(2)
    expect(enterReady(false, 1, "", false)).toBe(false)
    expect(enterReady(false, 1, "", true)).toBe(true)
  })
})
