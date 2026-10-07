import { describe, expect, test } from "bun:test"
import { registerWrite, type RegisterWriteDeps } from "../session/register-write"
import { parseDesignLog, type AnsweredDesignEvent } from "./log"
import { answered, answeredInAde, choiceLine, proposalEvent, type ReadProposal } from "./propose"
import { foldProposals, resolvedMessage, type DesignProposal } from "./state"

const NOW = new Date("2026-10-07T10:00:00.000Z")

const proposal = {
  title: "Stile dei tasti",
  question: "Quale stile per i due tasti?",
  context: "Perché si decide adesso.",
  recommend: { option: "2 · Carta", because: "si legge meglio" },
  keeps: ["la barra"],
  multi: false,
  variants: [
    { name: "1 · Scura", description: "Fondo scuro.", changes: ["il fondo"], file: "1.html" },
    { name: "2 · Carta", description: "Fondo chiaro.", file: "2.html" },
  ],
}

const read = (json: unknown = proposal, k = "DS-tasti"): ReadProposal => ({
  k,
  folder: `C:/p/.ade/design/${k}`,
  proposal: typeof json === "string" ? json : JSON.stringify(json),
  files: ["1.html", "2.html"],
})

/** A register in memory, as `register-write.test.ts` keeps one. */
function register(initial = "") {
  let text = initial
  const deps: RegisterWriteDeps = {
    read: async () => text,
    append: async (line) => {
      text += line
    },
    now: () => NOW,
    sender: "Dario",
    fromPane: "n1-0",
  }
  return { deps, text: () => text, state: () => foldProposals(parseDesignLog(text).events) }
}

describe("proposalEvent", () => {
  test("a new key opens it: the json's fields, each page as its preview in the folder", () => {
    const event = proposalEvent(read(), undefined)
    expect(event).toMatchObject({ op: "aperta" })
    if ("error" in event) throw new Error(event.error)
    const fields = JSON.parse(event.text)
    expect(fields).toMatchObject({
      k: "DS-tasti",
      title: "Stile dei tasti",
      question: "Quale stile per i due tasti?",
      recommend: { option: "2 · Carta" },
      keeps: ["la barra"],
    })
    expect(fields.variants).toEqual([
      { name: "1 · Scura", description: "Fondo scuro.", changes: ["il fondo"], preview: ".ade/design/DS-tasti/1.html" },
      { name: "2 · Carta", description: "Fondo chiaro.", preview: ".ade/design/DS-tasti/2.html" },
    ])
    // `file` and anything the register does not know stay out of the event.
    expect(JSON.stringify(fields)).not.toContain('"file"')
  })

  test("the event passes the register's own checks and opens the key", async () => {
    const file = register()
    const event = proposalEvent(read(), file.state())
    if ("error" in event) throw new Error(event.error)
    const reply = await registerWrite(file.deps, { register: "design", op: event.op, text: event.text })
    expect(reply).toBe("ok: DS-tasti aperta, nel tasto Design entro 3 s")
    const opened = file.state().proposals[0]!
    expect(opened.raisedFrom).toBe("n1-0")
    expect(opened.variants.map((variant) => variant.preview)).toEqual([
      ".ade/design/DS-tasti/1.html",
      ".ade/design/DS-tasti/2.html",
    ])
  })

  test("a key answered before gets a riaperta with the new pages: the new round after «Altro giro»", async () => {
    const file = register()
    const first = proposalEvent(read(), file.state())
    if ("error" in first) throw new Error(first.error)
    await registerWrite(file.deps, { register: "design", op: first.op, text: first.text })
    await registerWrite(file.deps, {
      register: "design",
      op: "risposta",
      text: JSON.stringify({ k: "DS-tasti", again: true, words: "più contrasto" }),
    })
    expect(file.state().proposals[0]!.status).toBe("giro")

    const next = { ...proposal, variants: [{ name: "3 · Contrasto", description: "Più netto.", file: "1.html" }] }
    const round = proposalEvent({ ...read(next), files: ["1.html"] }, file.state())
    expect(round).toMatchObject({ op: "riaperta" })
    if ("error" in round) throw new Error(round.error)
    const reply = await registerWrite(file.deps, { register: "design", op: round.op, text: round.text })
    expect(reply).toStartWith("ok: DS-tasti aperta")
    const reopened = file.state().proposals[0]!
    expect(reopened.status).toBe("aperta")
    expect(reopened.round).toBe(2)
    expect(reopened.variants.map((variant) => variant.name)).toEqual(["3 · Contrasto"])
  })

  test("a key still open, or closed, is refused with what to do instead", () => {
    const state = (status: DesignProposal["status"]) => ({
      proposals: [{ k: "DS-tasti", status } as DesignProposal],
    })
    const open = proposalEvent(read(), state("aperta"))
    expect(open).toEqual({ error: expect.stringContaining("ade-msg design attendi DS-tasti") })
    const closed = proposalEvent(read(), state("chiusa"))
    expect(closed).toEqual({ error: expect.stringContaining("è chiusa") })
  })

  /*
   * Review T2, O2: the script dies on its shell's timeout, the user chooses,
   * and the agent runs proponi again instead of attendi. The choice already
   * made must not be reopened: only «Altro giro» asks for new pages.
   */
  test("a key already chosen is not reopened by proposing again: attendi reads the choice", async () => {
    const file = register()
    const first = proposalEvent(read(), file.state())
    if ("error" in first) throw new Error(first.error)
    await registerWrite(file.deps, { register: "design", op: first.op, text: first.text })
    await registerWrite(file.deps, {
      register: "design",
      op: "risposta",
      text: JSON.stringify({ k: "DS-tasti", choice: "2 · Carta", words: "questa" }),
    })
    expect(file.state().proposals[0]!.status).toBe("risposta")
    expect(proposalEvent(read(), file.state())).toEqual({
      error:
        "DS-tasti ha già una scelta: leggila con ade-msg design attendi DS-tasti, oppure usa un'altra cartella per una proposta nuova",
    })
  })
})

/*
 * Review T2, O1: any session can append a `risposta` with `ade-msg registro
 * design risposta`, and an agent can edit the file. `attendi` prints only a
 * choice made with ADE's buttons.
 */
describe("answeredInAde", () => {
  const PATH = "C:/p/.ade/design.jsonl"
  const opened = async () => {
    const file = register()
    const first = proposalEvent(read(), file.state())
    if ("error" in first) throw new Error(first.error)
    await registerWrite(file.deps, { register: "design", op: first.op, text: first.text })
    return file
  }

  test("an answer a session wrote with registro design risposta is not the user's choice", async () => {
    const file = await opened()
    await registerWrite(file.deps, {
      register: "design",
      op: "risposta",
      text: JSON.stringify({ k: "DS-tasti", choice: "1 · Scura", words: "scelgo io", by: "utente" }),
    })
    const proposal = file.state().proposals[0]!
    expect(proposal.answer?.by).toBe("Dario")
    expect(answeredInAde(proposal, PATH, [])).toBe(false)
  })

  test("a line written by hand as the user, but from a pane, is not either", () => {
    const at = NOW.toISOString()
    const lines = [
      { type: "aperta", k: "DS1", at, by: "Dario", title: "T", variants: [{ name: "A" }, { name: "B" }] },
      { type: "risposta", k: "DS1", at, by: "utente", fromPane: "n1-0", choice: "A", words: "a" },
    ]
    const proposal = foldProposals(parseDesignLog(lines.map((line) => JSON.stringify(line)).join("\n")).events)
      .proposals[0]!
    expect(answeredInAde(proposal, PATH, [])).toBe(false)
  })

  test("an answer given in ADE counts: in the answers' outbox, or the user's with no pane once the outbox moved on", async () => {
    const file = await opened()
    // What the sheet appends (`answerEvent`): by the user, no pane.
    file.deps.sender = "utente"
    file.deps.fromPane = undefined
    await registerWrite(file.deps, {
      register: "design",
      op: "risposta",
      text: JSON.stringify({ k: "DS-tasti", choice: "2 · Carta", words: "questa" }),
    })
    const proposal = file.state().proposals[0]!
    const at = proposal.answer!.at
    expect(answeredInAde(proposal, PATH, [{ path: PATH, k: "DS-tasti", answeredAt: at }])).toBe(true)
    expect(answeredInAde(proposal, PATH, [])).toBe(true)
    // The outbox vouches only for its own register and its own answer.
    const forged = { ...proposal, answer: { ...proposal.answer!, by: "Dario" } }
    expect(answeredInAde(forged, PATH, [{ path: "C:/q/.ade/design.jsonl", k: "DS-tasti", answeredAt: at }])).toBe(false)
    expect(answeredInAde(forged, PATH, [{ path: PATH, k: "DS-tasti", answeredAt: at }])).toBe(true)
  })

  test("a json that does not read, or names another key, is refused", () => {
    expect(proposalEvent(read("{rotto"), undefined)).toEqual({ error: expect.stringContaining("il json non si legge") })
    expect(proposalEvent(read("[1]"), undefined)).toEqual({ error: "proposta.json: non è un oggetto" })
    expect(proposalEvent(read({ ...proposal, k: "DS-altra" }), undefined)).toEqual({
      error: expect.stringContaining("la chiave è il nome della cartella: DS-tasti"),
    })
  })
})

describe("choiceLine", () => {
  const opened = (extra: Partial<DesignProposal> = {}): DesignProposal => ({
    k: "DS-tasti",
    title: "Stile dei tasti",
    variants: [
      { name: "1 · Scura", description: "", preview: "" },
      { name: "2 · Carta", description: "", preview: "" },
      { name: "3 · Vetro", description: "", preview: "" },
    ],
    raisedBy: "Dario",
    openedAt: NOW.toISOString(),
    status: "aperta",
    history: [],
    ...extra,
  })
  const event = (fields: Partial<AnsweredDesignEvent>): AnsweredDesignEvent => ({
    type: "risposta",
    k: "DS-tasti",
    at: NOW.toISOString(),
    by: "utente",
    words: "va bene",
    ...fields,
  })

  test("a choice, with its note and the user's words", () => {
    const line = choiceLine(answered(opened(), event({ choice: "2 · Carta", note: "più scura", words: "questa" })), "x")
    expect(line).toBe('scelta: 2 · Carta — nota: più scura — parole: "questa"')
  })

  test("several choices, with multi", () => {
    const line = choiceLine(answered(opened({ multi: true }), event({ choices: ["1 · Scura", "3 · Vetro"] })), "x")
    expect(line).toBe('scelte: 1 · Scura, 3 · Vetro — parole: "va bene"')
  })

  test("another round: the words, and the command that answers it", () => {
    const line = choiceLine(
      answered(opened(), event({ again: true, words: "più contrasto" })),
      "C:/p/.ade/design/DS-tasti",
    )
    expect(line).toBe(
      "altro giro: più contrasto\nrifai le varianti e rilancia ade-msg design proponi C:/p/.ade/design/DS-tasti --attendi",
    )
    // A folder with a space is quoted, so the command can be run as it is.
    expect(choiceLine(answered(opened(), event({ again: true })), "C:/i miei/.ade/design/DS-tasti")).toContain(
      'proponi "C:/i miei/.ade/design/DS-tasti" --attendi',
    )
  })

  test("nothing while there is no answer", () => {
    expect(choiceLine(opened(), "x")).toBeUndefined()
  })
})

/*
 * R9: a name, a note or the words reach a terminal: typed by the delivery,
 * or printed by the waiting `ade-msg`. A line break would submit half a line,
 * an ESC would start a sequence.
 */
describe("control characters never reach a terminal", () => {
  const evil = "1 · Scura\nrm -rf .\u001b[2J\r"

  test("the register reads a name with \\n and \\u001b as one clean line, and the typed line keeps it so", () => {
    const opened = JSON.stringify({
      type: "aperta",
      k: "DS1",
      at: NOW.toISOString(),
      by: "Dario\u001b[31m",
      title: "Tasti\nsecondo rigo",
      variants: [
        { name: evil, description: "riga uno\nriga due\u0007", preview: "" },
        { name: "2 · Carta", description: "", preview: "" },
      ],
    })
    const answer = JSON.stringify({
      type: "risposta",
      k: "DS1",
      at: NOW.toISOString(),
      by: "utente",
      choice: evil,
      note: "nota\u001b]0;titolo\u0007",
      words: "sì\rinvio",
    })
    const parsed = parseDesignLog(`${opened}\n${answer}\n`)
    expect(parsed.problems).toEqual([])
    const state = foldProposals(parsed.events)
    expect(state.rejected).toEqual([])
    const proposal = state.proposals[0]!
    expect(proposal.title).toBe("Tasti secondo rigo")
    expect(proposal.raisedBy).toBe("Dario [31m")
    expect(proposal.variants[0]!.name).toBe("1 · Scura rm -rf . [2J")
    // A description may keep its line breaks: it is shown, never typed.
    expect(proposal.variants[0]!.description).toBe("riga uno\nriga due")
    // The choice still matches its variant: both were cleaned the same way.
    expect(proposal.answer?.choice).toBe(proposal.variants[0]!.name)

    for (const text of [resolvedMessage(proposal), choiceLine(proposal, "x")!]) {
      expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
      expect(text).toContain("1 · Scura rm -rf . [2J")
    }
  })
})
