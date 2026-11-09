import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { isUsersOwnAnswer, USER } from "../decisions/answer"
import { parseDecisionLog } from "../decisions/log"
import { createDecisionsRegister } from "../decisions/register"
import { foldDecisions } from "../decisions/state"
import { createDesignRegister } from "../design/register"
import { parseDesignLog } from "../design/log"
import { foldProposals } from "../design/state"
import { answerLedger, ANSWER_LEDGER_KEY, UNVOUCHED_BY, type AnswerStore } from "./answer-ledger"
import { askerLedger } from "./asker-ledger"
import { workbenchSource } from "../test-support/workbench-source"

/*
 * SEC-3 (audit 2026-11-09): a register line that says `"by":"utente"` was believed to be the user's click. An agent that
 * writes down what the user said in chat, by hand, does it with no malice at all; the panel then told the user they had
 * answered a decision they never saw, and `design attendi` printed the forged choice as theirs. ADE now keeps its own
 * record of the answers its buttons wrote, in the webview's storage, and a line of the user's that is not in it is
 * shown as reported by the register.
 */
const AT = "2026-11-09T10:00:00.000Z"
const ANSWERED_AT = "2026-11-09T10:05:00.000Z"
const DECISIONS = "C:/p/.ade/decisions.jsonl"
const DESIGN = "C:/p/.ade/design.jsonl"

function memory(): AnswerStore & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) }
}

/** A ledger over one store that stays the same between its calls, as the webview's storage does. */
function fresh() {
  const store = memory()
  return answerLedger(() => store)
}

const asked = JSON.stringify({
  type: "aperta",
  k: "D1",
  at: AT,
  by: "Master",
  title: "Tasto",
  options: [{ label: "A" }, { label: "B" }],
})
const handWritten = JSON.stringify({ type: "risposta", k: "D1", at: ANSWERED_AT, by: "utente", words: "A", choice: "A" })

const decisionOf = (text: string, ledger: ReturnType<typeof answerLedger>) =>
  foldDecisions(ledger.vouch(DECISIONS, parseDecisionLog(text).events), new Date(AT)).decisions[0]!

describe("the answers ADE wrote (SEC-3)", () => {
  test("a hand-written line of the user's is shown as reported by the register, not as the user's click", () => {
    const ledger = fresh()
    const decision = decisionOf(`${asked}\n${handWritten}`, ledger)
    expect(decision.status).toBe("risposta")
    expect(decision.answer?.by).toBe(UNVOUCHED_BY)
    expect(isUsersOwnAnswer(decision.answer!)).toBe(false)
  })

  test("the same line, once ADE has remembered writing it, stays the user's", () => {
    const ledger = fresh()
    ledger.remember(DECISIONS, "D1", ANSWERED_AT)
    const decision = decisionOf(`${asked}\n${handWritten}`, ledger)
    expect(decision.answer?.by).toBe(USER)
    expect(isUsersOwnAnswer(decision.answer!)).toBe(true)
  })

  test("it vouches for one register and one time only", () => {
    const ledger = fresh()
    ledger.remember(DECISIONS, "D1", ANSWERED_AT)
    const elsewhere = ledger.vouch("C:/altro/.ade/decisions.jsonl", parseDecisionLog(`${asked}\n${handWritten}`).events)
    expect(foldDecisions(elsewhere, new Date(AT)).decisions[0]!.answer?.by).toBe(UNVOUCHED_BY)
    const later = JSON.stringify({ ...JSON.parse(handWritten), at: "2026-11-09T11:00:00.000Z" })
    expect(decisionOf(`${asked}\n${later}`, ledger).answer?.by).toBe(UNVOUCHED_BY)
    expect(ledger.has(DECISIONS, "D1", ANSWERED_AT)).toBe(true)
    expect(ledger.has(DECISIONS, "D1", "2026-11-09T11:00:00.000Z")).toBe(false)
  })

  test("a session's line, and a line with a pane, are left as they are", () => {
    const ledger = fresh()
    const events = [
      { k: "D1", at: AT, by: "Master" },
      { k: "D2", at: AT, by: "utente", fromPane: "p-1" },
    ]
    expect(ledger.vouch(DECISIONS, events)).toEqual(events)
  })

  test("every kind of line the user's buttons write is covered, not only the answer", () => {
    const ledger = fresh()
    const kinds = ["risposta", "rimandata", "riaperta"].map((type) => ({ type, k: "D1", at: AT, by: "utente" }))
    expect(ledger.vouch(DECISIONS, kinds).map((event) => event.by)).toEqual([UNVOUCHED_BY, UNVOUCHED_BY, UNVOUCHED_BY])
  })

  test("the record is kept to the newest entries, and a broken or missing one vouches for nothing", () => {
    const store = memory()
    const ledger = answerLedger(() => store, 2)
    for (const k of ["D1", "D2", "D3"]) ledger.remember(DECISIONS, k, AT)
    expect(JSON.parse(store.items.get(ANSWER_LEDGER_KEY)!)).toHaveLength(2)
    expect(ledger.has(DECISIONS, "D1", AT)).toBe(false)
    expect(ledger.has(DECISIONS, "D3", AT)).toBe(true)
    store.items.set(ANSWER_LEDGER_KEY, "{rotto")
    expect(ledger.has(DECISIONS, "D3", AT)).toBe(false)
    const none = answerLedger(() => undefined)
    none.remember(DECISIONS, "D1", AT)
    expect(none.vouch(DECISIONS, [{ k: "D1", at: AT, by: "utente" }])[0]!.by).toBe(UNVOUCHED_BY)
  })

  test("storage that refuses the write does not stop the answer", () => {
    const refusing: AnswerStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota")
      },
    }
    expect(() => answerLedger(() => refusing).remember(DECISIONS, "D1", AT)).not.toThrow()
  })

  test("seeding puts the answers ADE gave and that still stand in the record", () => {
    const ledger = fresh()
    ledger.seed([
      { path: DECISIONS, k: "D1", answeredAt: AT },
      { path: DESIGN, k: "DS-1", answeredAt: AT },
    ])
    expect(ledger.has(DECISIONS, "D1", AT)).toBe(true)
    expect(ledger.has(DESIGN, "DS-1", AT)).toBe(true)
  })

  test("with the pane vouch first, a line of the user's naming an unknown pane is reported too", () => {
    const answers = fresh()
    const askers = askerLedger(() => memory())
    const line = JSON.stringify({ ...JSON.parse(handWritten), fromPane: "p-altro" })
    const events = answers.vouch(DECISIONS, askers.vouch(DECISIONS, parseDecisionLog(`${asked}\n${line}`).events))
    expect(foldDecisions(events, new Date(AT)).decisions[0]!.answer?.by).toBe(UNVOUCHED_BY)
  })
})

/** A register file in memory: the registers read and append to it as they do on disk. */
function fileIo(initial: string) {
  let text = initial
  return {
    text: () => text,
    io: {
      readTextFile: async () => ({ text, truncated: false }),
      writeTextFile: async (_path: string, contents: string) => {
        text = contents
        return null
      },
      appendTextFile: async (_path: string, add: string) => {
        text += add
        return null
      },
    },
  }
}

describe("the registers remember what their own append writes (SEC-3)", () => {
  test("decisions: the user's answer through the register stays theirs; a hand-written one beside it is reported", async () => {
    const forged = JSON.stringify({ type: "risposta", k: "D2", at: AT, by: "utente", words: "B", choice: "B" })
    const second = JSON.stringify({
      type: "aperta",
      k: "D2",
      at: AT,
      by: "Master",
      title: "Altro",
      options: [{ label: "A" }, { label: "B" }],
    })
    const file = fileIo(`${asked}\n${second}\n${forged}\n`)
    const ledger = fresh()
    await createRoot(async (dispose) => {
      const register = createDecisionsRegister({
        path: () => DECISIONS,
        io: async () => file.io,
        vouch: ledger.vouch,
        remember: ledger.remember,
      })
      await register.append({ type: "risposta", k: "D1", at: "2026-11-09T10:30:00.000Z", by: USER, words: "A", choice: "A" })
      const decisions = register.state()!.decisions
      const d1 = decisions.find((d) => d.k === "D1")!
      const d2 = decisions.find((d) => d.k === "D2")!
      expect(d1.answer?.by).toBe(USER)
      expect(isUsersOwnAnswer(d1.answer!)).toBe(true)
      expect(d2.answer?.by).toBe(UNVOUCHED_BY)
      expect(isUsersOwnAnswer(d2.answer!)).toBe(false)
      dispose()
    })
  })

  test("design: the same", async () => {
    const proposal = (k: string, by: string) =>
      JSON.stringify({
        type: "aperta",
        k,
        at: AT,
        by,
        title: "Design",
        question: "Q?",
        context: "C",
        variants: [
          { name: "1", description: "d", preview: "" },
          { name: "2", description: "d", preview: "" },
        ],
      })
    const forged = JSON.stringify({ type: "risposta", k: "DS-2", at: AT, by: "utente", words: "due", choice: "2" })
    const file = fileIo(`${proposal("DS-1", "Master")}\n${proposal("DS-2", "Master")}\n${forged}\n`)
    const ledger = fresh()
    await createRoot(async (dispose) => {
      const register = createDesignRegister({
        path: () => DESIGN,
        io: async () => file.io,
        vouch: ledger.vouch,
        remember: ledger.remember,
      })
      await register.append({ type: "risposta", k: "DS-1", at: "2026-11-09T10:30:00.000Z", by: USER, words: "uno", choice: "1" })
      const proposals = register.state()!.proposals
      expect(proposals.find((p) => p.k === "DS-1")!.answer?.by).toBe(USER)
      expect(proposals.find((p) => p.k === "DS-2")!.answer?.by).toBe(UNVOUCHED_BY)
      dispose()
    })
  })
})

describe("the design register read straight from the file (SEC-3)", () => {
  test("a hand-written choice folds to a reported one once vouched", () => {
    const ledger = fresh()
    const text = [
      JSON.stringify({
        type: "aperta",
        k: "DS-1",
        at: AT,
        by: "Master",
        title: "Design",
        question: "Q?",
        context: "C",
        variants: [
          { name: "1", description: "d", preview: "" },
          { name: "2", description: "d", preview: "" },
        ],
      }),
      JSON.stringify({ type: "risposta", k: "DS-1", at: AT, by: "utente", words: "due", choice: "2" }),
    ].join("\n")
    const proposal = foldProposals(ledger.vouch(DESIGN, parseDesignLog(text).events)).proposals[0]!
    expect(isUsersOwnAnswer(proposal.answer!)).toBe(false)
  })
})

describe("the workbench wires it (SEC-3)", () => {
  // The workbench cannot be loaded under bun: read from the source. Booleans, so a failure does not print the file.
  const source = workbenchSource()

  test("both registers vouch through it after the pane vouch and remember their own appends; attendi asks it; the outbox seeds it", () => {
    const vouch = "vouch: (path, events) => answers.vouch(path, askers.vouch(path, events)),"
    expect(source.split(vouch).length - 1).toBe(2)
    expect(source.split("remember: answers.remember,").length - 1).toBe(2)
    expect(source.includes("answeredInAde(found, path, designOutbox(), answers.has)")).toBe(true)
    expect(source.includes("answers.seed([...decisionsOutbox(), ...designOutbox()])")).toBe(true)
  })
})
