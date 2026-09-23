import { describe, expect, test } from "bun:test"
import { pruneOutbox, submitGate } from "./delivery"
import { previewSize } from "./design-preview"
import { parseDesignLog, serializeDesignEvent, toEvent, type DesignEvent } from "./log"
import { bucketProposals, describeProblems, foldProposals, nextDesignKey, resolvedMessage } from "./state"
import { appendDesignEvent, designPath, loadDesign, type DesignIo } from "./store"

const at = (minute: number) => new Date(Date.UTC(2026, 8, 21, 16, minute)).toISOString()

const opened = (k: string, extra: Partial<DesignEvent> = {}): DesignEvent =>
  ({
    type: "aperta",
    k,
    at: at(0),
    by: "fable",
    title: `Titolo ${k}`,
    spec: "S54",
    variants: [
      { name: "A", description: "desc A", preview: "C:/path/a.html" },
      { name: "B", description: "desc B", preview: "C:/path/b.png" },
    ],
    ...extra,
  }) as DesignEvent

const answered = (k: string, words: string, minute = 5): DesignEvent => ({
  type: "risposta",
  k,
  at: at(minute),
  by: "utente",
  choice: "A",
  words,
})

describe("the design log on disk", () => {
  test("round-trips an event as one line, dropping empty fields", () => {
    const line = serializeDesignEvent({ ...(opened("DS1") as object), context: "  " } as DesignEvent)
    expect(line.endsWith("\n")).toBe(true)
    expect(line.slice(0, -1).includes("\n")).toBe(false)
    expect(line).not.toContain("context")
    expect(parseDesignLog(line).events).toEqual([opened("DS1")])
  })

  test("a line break inside the user's words stays inside one line", () => {
    const line = serializeDesignEvent(answered("DS1", "Variante A,\ncon layout compatto"))
    expect(line.split("\n").length).toBe(2)
    expect((parseDesignLog(line).events[0] as { words: string }).words).toBe("Variante A,\ncon layout compatto")
  })

  test("broken lines become problems and the rest still counts", () => {
    const text = [
      JSON.stringify(opened("DS1")),
      "{not json",
      "",
      JSON.stringify({ type: "boh", k: "DS1", at: at(1), by: "x" }),
      '{"type":"aperta","k":"DS2"',
    ].join("\n")
    const parsed = parseDesignLog(text)
    expect(parsed.events.map((e) => e.k)).toEqual(["DS1"])
    expect(parsed.problems).toEqual([
      { line: 2, reason: "JSON non valido" },
      { line: 4, reason: "tipo sconosciuto" },
      { line: 5, reason: "JSON non valido" },
    ])
  })

  test("an answer without the user's words is not an answer", () => {
    expect(toEvent({ type: "risposta", k: "DS1", at: at(1), by: "utente", choice: "A" })).toBe("risposta senza le parole dell'utente")
  })

  test("keys, dates and variants are checked", () => {
    expect(toEvent({ ...opened("DS1"), k: "DS 1" })).toBe("chiave mancante o non valida")
    expect(toEvent({ ...opened("DS1"), at: "ieri" })).toBe("data mancante o non valida")
    expect(toEvent({ ...opened("DS1"), variants: [] })).toBe("varianti mancanti o non valide")
    expect(toEvent({ ...opened("DS1"), variants: [{ description: "senza nome", preview: "" }] })).toBe("variante senza nome")
  })
})

describe("folding events into design proposals", () => {
  test("open, answer in the user's words, close", () => {
    const { proposals, rejected } = foldProposals([
      opened("DS1"),
      answered("DS1", "A — mi piace la direzione a gruppi"),
      { type: "chiusa", k: "DS1", at: at(9), by: "Master", evidence: "commit 12345" },
    ])
    expect(rejected).toEqual([])
    expect(proposals[0]).toMatchObject({
      k: "DS1",
      status: "chiusa",
      answer: { choice: "A", words: "A — mi piace la direzione a gruppi", by: "utente" },
      evidence: "commit 12345",
    })
    expect(proposals[0]!.history.map((e) => e.type)).toEqual(["aperta", "risposta", "chiusa"])
  })

  test("duplicate open or events on unknown proposal are rejected", () => {
    const { proposals, rejected } = foldProposals([
      opened("DS1"),
      opened("DS1"),
      answered("UNKNOWN", "parole"),
    ])
    expect(proposals.length).toBe(1)
    expect(rejected.length).toBe(2)
  })

  test("cannot answer already answered proposal without reopening", () => {
    const { proposals, rejected } = foldProposals([
      opened("DS1"),
      answered("DS1", "prima risposta"),
      answered("DS1", "seconda risposta"),
    ])
    expect(proposals[0]!.answer?.words).toBe("prima risposta")
    expect(rejected.length).toBe(1)
  })
})

describe("buckets and messages", () => {
  test("proposals in buckets by status and order", () => {
    const p1 = opened("DS1", { order: 2 })
    const p2 = opened("DS2", { order: 1 })
    const { proposals } = foldProposals([p1, p2, answered("DS1", "scelta A")])
    const buckets = bucketProposals(proposals)
    expect(buckets.forYou.map((p) => p.k)).toEqual(["DS2"])
    expect(buckets.answered.map((p) => p.k)).toEqual(["DS1"])
  })

  test("the message to session starts with design verb and keeps user words", () => {
    const { proposals } = foldProposals([opened("DS1"), answered("DS1", "scelta B per S54")])
    expect(resolvedMessage(proposals[0]!)).toBe(
      'design [k=DS1] Titolo DS1 — scelta: A — parole: "scelta B per S54" — spec: S54',
    )
  })

  test("nextDesignKey generates sequentially", () => {
    expect(nextDesignKey([])).toBe("DS1")
    expect(nextDesignKey([{ k: "DS1" }, { k: "DS5" }])).toBe("DS6")
  })
})

describe("the design store", () => {
  test("the path: default inside the project, relative or absolute setting", () => {
    expect(designPath("C:\\project")).toBe("C:\\project\\.ade\\design.jsonl")
    expect(designPath("/home/user/project")).toBe("/home/user/project/.ade/design.jsonl")
    expect(designPath("C:\\project", "custom\\design.jsonl")).toBe("C:\\project\\custom\\design.jsonl")
    expect(designPath("C:\\project", "D:\\shared\\design.jsonl")).toBe("D:\\shared\\design.jsonl")
  })

  test("a missing register is empty, and the first append creates it", async () => {
    const files = new Map<string, string>()
    const io: DesignIo = {
      readTextFile: async (path) => {
        if (!files.has(path)) throw new Error("not found")
        return { text: files.get(path)!, truncated: false }
      },
      writeTextFile: async (path, contents) => {
        files.set(path, contents)
        return null
      },
    }

    const initial = await loadDesign(io, "C:\\project\\.ade\\design.jsonl")
    expect(initial.events).toEqual([])
    expect(initial.state.proposals).toEqual([])

    await appendDesignEvent(io, "C:\\project\\.ade\\design.jsonl", opened("DS1"))
    const after = await loadDesign(io, "C:\\project\\.ade\\design.jsonl")
    expect(after.events.length).toBe(1)
    expect(after.state.proposals[0]!.k).toBe("DS1")
  })
})

describe("the answer button's gate", () => {
  test("sends only to a session that is ready; otherwise it asks who receives", () => {
    expect(submitGate({ state: "pronta", id: "p1", title: "Master" })).toBe("invia")
    expect(submitGate({ state: "non scelta" })).toBe("scegli")
    expect(submitGate({ state: "non attiva", id: "p2", title: "fable" })).toBe("scegli")
  })
})

describe("another round (S75 point 2)", () => {
  const again = (k: string, extra: Record<string, unknown> = {}, minute = 5) =>
    ({ type: "risposta", k, at: at(minute), by: "utente", words: "più contrasto, meno vetro", again: true, ...extra }) as unknown as DesignEvent
  const reopened = (k: string, extra: Record<string, unknown> = {}, minute = 7) =>
    ({ type: "riaperta", k, at: at(minute), by: "fable", ...extra }) as unknown as DesignEvent

  test("again with a choice, or without words, is a line problem", () => {
    expect(toEvent(again("DS1", { choice: "A" }))).toBe("un altro giro dice cosa cambiare, senza scelta")
    expect(toEvent(again("DS1", { choices: ["A"] }))).toBe("un altro giro dice cosa cambiare, senza scelta")
    expect(toEvent(again("DS1", { words: " " }))).toBe("un altro giro dice cosa cambiare, senza scelta")
    expect(toEvent(again("DS1"))).toMatchObject({ type: "risposta", again: true })
  })

  test("a riaperta with an empty variant list is a line problem", () => {
    expect(typeof toEvent(reopened("DS1", { variants: [] }))).toBe("string")
    expect(toEvent(reopened("DS1"))).toMatchObject({ type: "riaperta", k: "DS1" })
  })

  test("aperta, then again: giro, out of forYou, into rework", () => {
    const { proposals, rejected } = foldProposals([opened("DS1"), again("DS1")])
    expect(rejected).toEqual([])
    expect(proposals[0]!.status).toBe("giro")
    const buckets = bucketProposals(proposals)
    expect(buckets.forYou).toEqual([])
    expect(buckets.rework.map((p) => p.k)).toEqual(["DS1"])
  })

  test("then riaperta with two new variants: open again, round 2, no answer", () => {
    const variants = [
      { name: "C", description: "", preview: ".ade/design/DS1/1.html" },
      { name: "D", description: "", preview: ".ade/design/DS1/2.html" },
    ]
    const { proposals, rejected } = foldProposals([opened("DS1"), again("DS1"), reopened("DS1", { variants })])
    expect(rejected).toEqual([])
    const proposal = proposals[0]!
    expect(proposal.status).toBe("aperta")
    expect(bucketProposals(proposals).forYou.map((p) => p.k)).toEqual(["DS1"])
    expect(proposal.variants).toEqual(variants)
    expect(proposal.round).toBe(2)
    expect(proposal.answer).toBeUndefined()
  })

  test("riaperta on an open proposal is rejected, and so is an answer on a giro", () => {
    const onOpen = foldProposals([opened("DS1"), reopened("DS1")])
    expect(onOpen.rejected.map((r) => r.reason)).toEqual(["DS1 è già aperta"])
    const onGiro = foldProposals([opened("DS1"), again("DS1"), answered("DS1", "A", 6)])
    expect(onGiro.rejected.length).toBe(1)
    expect(onGiro.proposals[0]!.status).toBe("giro")
  })

  test("the message for another round is work, not a choice", () => {
    const { proposals } = foldProposals([opened("DS1"), again("DS1")])
    const message = resolvedMessage(proposals[0]!)
    expect(message).toContain("ALTRO GIRO")
    expect(message).toContain("riaperta")
    expect(message).toBe(
      'design [k=DS1] Titolo DS1 — ALTRO GIRO, non una scelta — parole: "più contrasto, meno vetro" — rifai le varianti e riapri con: ade-msg registro design riaperta',
    )
  })

  test("the outbox keeps the answer of a proposal in giro", () => {
    const path = "C:\p\.ade\design.jsonl"
    const { proposals } = foldProposals([opened("DS1"), again("DS1")])
    const item = { path, k: "DS1", answeredAt: at(5), queuedAt: 1 }
    expect(pruneOutbox([item], path, proposals)).toEqual([item])
  })
})

describe("multiple answers (S75 point 6)", () => {
  const open = (extra: Record<string, unknown> = {}) =>
    ({ ...opened("DS40"), variants: [{ name: "A", description: "", preview: "" }, { name: "B", description: "", preview: "" }, { name: "C", description: "", preview: "" }], multi: true, ...extra }) as unknown as DesignEvent
  const answer = (extra: Record<string, unknown>) =>
    ({ type: "risposta", k: "DS40", at: at(5), by: "utente", words: "A + C", ...extra }) as unknown as DesignEvent

  test("multi with a single variant is a line problem; choice and choices together too", () => {
    expect(toEvent(open({ variants: [{ name: "A" }] }))).toBe("una scelta multipla vuole almeno due varianti")
    expect(toEvent(answer({ choice: "A", choices: ["A", "C"] }))).toBe("choice e choices insieme")
  })

  test("on a multi proposal valid choices answer it; an unknown one or a choice is refused", () => {
    const good = foldProposals([open(), answer({ choices: ["A", "C"] })])
    expect(good.rejected).toEqual([])
    expect(good.proposals[0]).toMatchObject({ status: "risposta", answer: { choices: ["A", "C"] } })
    expect(foldProposals([open(), answer({ choices: ["Z"] })]).rejected.map((r) => r.reason)).toEqual(["DS40: una delle scelte non è una variante"])
    expect(foldProposals([open(), answer({ choice: "A" })]).rejected.map((r) => r.reason)).toEqual(["DS40 è a scelta multipla: si risponde con choices"])
  })

  test("on a single proposal choices is refused", () => {
    expect(foldProposals([open({ multi: undefined }), answer({ choices: ["A"] })]).rejected).toHaveLength(1)
  })

  test("the message says scelte: A + C", () => {
    const { proposals } = foldProposals([open(), answer({ choices: ["A", "C"] })])
    expect(resolvedMessage(proposals[0]!)).toBe('design [k=DS40] Titolo DS40 — scelte: A + C — parole: "A + C" — spec: S54')
  })
})

describe("a preview's size (S75 point 3)", () => {
  test("read from the ade-size meta", () => {
    expect(previewSize('<head><meta name="ade-size" content="520x300"></head>')).toEqual({ width: 520, height: 300 })
    expect(previewSize("<meta content='200x120' name='ade-size'>")).toEqual({ width: 200, height: 120 })
  })

  test("absent: 360×240", () => {
    expect(previewSize("<html><body>x</body></html>")).toEqual({ width: 360, height: 240 })
  })

  test("out of range: 360×240", () => {
    expect(previewSize('<meta name="ade-size" content="100x240">')).toEqual({ width: 360, height: 240 })
    expect(previewSize('<meta name="ade-size" content="1700x240">')).toEqual({ width: 360, height: 240 })
  })

  test("malformed: 360×240", () => {
    expect(previewSize('<meta name="ade-size" content="largo">')).toEqual({ width: 360, height: 240 })
    expect(previewSize('<meta name="ade-size" content="360 per 240">')).toEqual({ width: 360, height: 240 })
  })
})
