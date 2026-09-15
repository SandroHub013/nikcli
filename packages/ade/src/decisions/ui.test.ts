import { describe, expect, test } from "bun:test"
import { answerEvent, countLabel, deferFromInput, deferPresets, formatDay, sheetKey } from "./answer"
import { deliveryLine, deliveryState, enqueue, markDelivered, parseOutbox, pendingFor, pickRecipient, pruneOutbox } from "./delivery"
import type { DecisionEvent } from "./log"
import { foldDecisions } from "./state"

const decision = { k: "D21", options: [{ label: "A · Rifinitura" }, { label: "B · Estensioni" }] }

describe("the window's keys", () => {
  test("digits pick, Enter records, Esc closes, arrows move", () => {
    expect(sheetKey({ key: "2" }, 2, false)).toEqual({ kind: "pick", index: 1 })
    expect(sheetKey({ key: "3" }, 2, false)).toBeUndefined()
    expect(sheetKey({ key: "Enter" }, 2, false)).toEqual({ kind: "submit" })
    expect(sheetKey({ key: "Escape" }, 2, true)).toEqual({ kind: "close" })
    expect(sheetKey({ key: "ArrowRight" }, 2, false)).toEqual({ kind: "next" })
  })

  test("in the note, keys are typing; only Ctrl+Enter records", () => {
    expect(sheetKey({ key: "2" }, 2, true)).toBeUndefined()
    expect(sheetKey({ key: "Enter" }, 2, true)).toBeUndefined()
    expect(sheetKey({ key: "ArrowLeft" }, 2, true)).toBeUndefined()
    expect(sheetKey({ key: "Enter", ctrlKey: true }, 2, true)).toEqual({ kind: "submit" })
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

  test("the running Master of the project, else whoever raised it, else nobody", () => {
    expect(pickRecipient(panes, { raisedBy: "Dario" }, "nikcli")?.id).toBe("d")
    expect(pickRecipient(panes.slice(0, 3), { raisedBy: "dario" }, "nikcli")?.id).toBe("a")
    expect(pickRecipient(panes.slice(1, 3), { raisedBy: "Dario" }, "nikcli")).toBeUndefined()
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
