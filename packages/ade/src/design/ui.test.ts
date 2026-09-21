import { describe, expect, test } from "bun:test"
import { answerEvent, countLabel, sheetKey } from "./answer"
import {
  chooseRecipient,
  deliveryLine,
  deliveryState,
  enqueue,
  markDelivered,
  parseOutbox,
  parseRecipients,
  pendingFor,
  pruneOutbox,
  recipientChange,
  recipientOptions,
  resolveRecipient,
  type DeliveryCandidate,
  type OutboxItem,
} from "./delivery"
import { isHtmlPreview, isImagePreview } from "./design-preview"
import type { DesignProposal } from "./state"

describe("the design sheet keys", () => {
  test("digits pick variant, Enter records, Esc closes, arrows navigate, f expands", () => {
    expect(sheetKey({ key: "Escape" }, 3, false, false)).toEqual({ kind: "close" })
    expect(sheetKey({ key: "1" }, 3, false, false)).toEqual({ kind: "pick", index: 0 })
    expect(sheetKey({ key: "3" }, 3, false, false)).toEqual({ kind: "pick", index: 2 })
    expect(sheetKey({ key: "4" }, 3, false, false)).toBeUndefined()
    expect(sheetKey({ key: "Enter" }, 3, false, true)).toEqual({ kind: "submit" })
    expect(sheetKey({ key: "Enter" }, 3, false, false)).toEqual({ kind: "need-choice" })
    expect(sheetKey({ key: "ArrowRight" }, 3, false, false)).toEqual({ kind: "next" })
    expect(sheetKey({ key: "ArrowLeft" }, 3, false, false)).toEqual({ kind: "previous" })
    expect(sheetKey({ key: "f" }, 3, false, false)).toEqual({ kind: "expand" })
  })

  test("in the note textarea, keys type normally; Ctrl+Enter submits", () => {
    expect(sheetKey({ key: "1" }, 3, true, false)).toBeUndefined()
    expect(sheetKey({ key: "Enter" }, 3, true, true)).toBeUndefined()
    expect(sheetKey({ key: "Enter", ctrlKey: true }, 3, true, false)).toEqual({ kind: "submit" })
  })
})

describe("an answer event for design", () => {
  const proposal: DesignProposal = {
    k: "DS1",
    title: "Settings UI",
    variants: [
      { name: "A", description: "Rail", preview: "a.html" },
      { name: "B", description: "Cards", preview: "b.html" },
    ],
    raisedBy: "fable",
    openedAt: "2026-09-21T10:00:00Z",
    status: "aperta",
    history: [],
  }

  test("carries variant name and note together as user words", () => {
    const event = answerEvent(proposal, 0, "Bello il rail", new Date("2026-09-21T11:00:00Z"))
    expect(event).toMatchObject({
      type: "risposta",
      k: "DS1",
      choice: "A",
      note: "Bello il rail",
      words: "A — Bello il rail",
    })
  })

  test("cannot be empty", () => {
    expect(answerEvent(proposal, undefined, "  ", new Date())).toBe("scegli una variante o scrivi una nota")
  })
})

describe("who receives design answers", () => {
  const candidates: DeliveryCandidate[] = [
    { id: "p1", title: "Master", project: "nikcli", running: true },
    { id: "p2", title: "fable", project: "nikcli", running: false },
  ]

  test("resolves chosen session or non scelta", () => {
    expect(resolveRecipient(candidates, undefined)).toEqual({ state: "non scelta" })
    expect(resolveRecipient(candidates, { id: "p1", title: "Master" })).toEqual({
      state: "pronta",
      id: "p1",
      title: "Master",
    })
    expect(resolveRecipient(candidates, { id: "p2", title: "fable" })).toEqual({
      state: "non attiva",
      id: "p2",
      title: "fable",
    })
  })

  test("deliveryLine formats with [Design da utente]", () => {
    const proposal: DesignProposal = {
      k: "DS1",
      title: "Impostazioni",
      spec: "S54",
      variants: [{ name: "A", description: "", preview: "" }],
      raisedBy: "fable",
      openedAt: "2026-09-21T10:00:00Z",
      status: "risposta",
      answer: {
        choice: "A",
        words: "A — approvata",
        at: "2026-09-21T11:00:00Z",
        by: "utente",
      },
      history: [],
    }
    expect(deliveryLine(proposal)).toBe(
      '[Design da utente] design [k=DS1] Impostazioni — scelta: A — parole: "A — approvata" — spec: S54',
    )
  })

  test("outbox queueing and delivery state tracking", () => {
    let outbox: OutboxItem[] = []
    outbox = enqueue(outbox, {
      path: "C:\\p\\.ade\\design.jsonl",
      k: "DS1",
      answeredAt: "2026-09-21T11:00:00Z",
      queuedAt: 1000,
    })
    expect(pendingFor(outbox, "C:\\p\\.ade\\design.jsonl").length).toBe(1)

    outbox = markDelivered(outbox, outbox[0]!, "Master", 2000)
    expect(pendingFor(outbox, "C:\\p\\.ade\\design.jsonl").length).toBe(0)
  })
})

describe("preview type security detection", () => {
  test("identifies HTML and images correctly", () => {
    expect(isHtmlPreview("C:/results/S54-anteprima.html")).toBe(true)
    expect(isHtmlPreview("<!doctype html><html><body>Test</body></html>")).toBe(true)
    expect(isHtmlPreview("mockup.png")).toBe(false)

    expect(isImagePreview("screen.png")).toBe(true)
    expect(isImagePreview("photo.jpg")).toBe(true)
    expect(isImagePreview("data:image/png;base64,abc")).toBe(true)
    expect(isImagePreview("S54-anteprima.html")).toBe(false)
  })
})
