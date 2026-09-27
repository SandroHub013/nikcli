import { describe, expect, test } from "bun:test"
import { answerItem } from "../decisions/delivery"
import { parseDecisionLog } from "../decisions/log"
import { foldDecisions } from "../decisions/state"
import { parseDesignLog } from "../design/log"
import { foldProposals } from "../design/state"
import { askerLedger, ASKER_LEDGER_KEY, type AskerStore } from "./asker-ledger"
import { registerWrite, type RegisterWriteDeps } from "./register-write"

/*
 * notifiche-design review, BASSO 1: `fromPane` was read from any line of the
 * register, so a line written into the file by hand could send the user's
 * answer, and its own question, to another pane's terminal. ADE now trusts a
 * `fromPane` only when it remembers writing that question for that pane.
 */
const NOW = new Date("2026-09-27T12:00:00.000Z")
const PATH = "C:/progetto/.ade/decisions.jsonl"

function memory(): AskerStore & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) }
}

function file(extra: Partial<RegisterWriteDeps> = {}) {
  let text = ""
  const deps: RegisterWriteDeps = {
    read: async () => text,
    append: async (line) => {
      text += line
    },
    now: () => NOW,
    sender: "Lucia",
    ...extra,
  }
  return {
    deps,
    text: () => text,
    add: (line: string) => (text += `${text && !text.endsWith("\n") ? "\n" : ""}${line}`),
  }
}

const opened = (k: string) => JSON.stringify({ k, title: "Tasto", options: [{ label: "A" }, { label: "B" }] })

describe("the asking pane ADE remembers", () => {
  test("ade-msg registro remembers the question it opened, and only that", async () => {
    const remembered: [string, string][] = []
    const register = file({ fromPane: "p-lucia", remember: (k, at) => void remembered.push([k, at]) })
    expect(await registerWrite(register.deps, { register: "decisioni", op: "aperta", text: opened("D1") })).toStartWith(
      "ok: D1",
    )
    expect(remembered).toEqual([["D1", NOW.toISOString()]])
    await registerWrite(register.deps, { register: "decisioni", op: "rimandata", text: JSON.stringify({ k: "D1" }) })
    expect(remembered).toHaveLength(1)
  })

  test("a question ADE wrote keeps its pane; one written by hand loses it", async () => {
    const store = memory()
    const ledger = askerLedger(() => store)
    const register = file({
      fromPane: "p-lucia",
      agent: "agy",
      remember: (k, at) => ledger.remember(PATH, k, at, "p-lucia"),
    })
    await registerWrite(register.deps, { register: "decisioni", op: "aperta", text: opened("D1") })
    // By hand, naming another pane, and a copy of D1's own line into another project.
    register.add(
      JSON.stringify({
        type: "aperta",
        k: "D2",
        at: NOW.toISOString(),
        by: "Lucia",
        fromPane: "p-altro",
        agent: "claude-code",
        title: "Finta",
        options: [{ label: "A" }, { label: "B" }],
      }),
    )
    const events = ledger.vouch(PATH, parseDecisionLog(register.text()).events)
    const state = foldDecisions(events, NOW)
    const d1 = state.decisions.find((d) => d.k === "D1")!
    const d2 = state.decisions.find((d) => d.k === "D2")!
    expect([d1.raisedFrom, d1.raisedAgent]).toEqual(["p-lucia", "agy"])
    expect([d2.raisedFrom, d2.raisedAgent]).toEqual([undefined, undefined])
    // D2's answer goes to «Risposte a», not to p-altro.
    expect(answerItem(PATH, d2, NOW.toISOString(), 0).toId).toBeUndefined()
    const elsewhere = ledger.vouch("C:/altro/.ade/decisions.jsonl", parseDecisionLog(register.text()).events)
    expect(foldDecisions(elsewhere, NOW).decisions.find((d) => d.k === "D1")!.raisedFrom).toBeUndefined()
  })

  test("a line naming the right key and time but another pane loses it", () => {
    const store = memory()
    const ledger = askerLedger(() => store)
    ledger.remember(PATH, "DS1", NOW.toISOString(), "p-opus")
    const line = JSON.stringify({
      type: "aperta",
      k: "DS1",
      at: NOW.toISOString(),
      by: "Opus",
      fromPane: "p-altro",
      title: "Tasto",
      variants: [
        { name: "A", description: "", preview: "" },
        { name: "B", description: "", preview: "" },
      ],
    })
    const proposal = foldProposals(ledger.vouch(PATH, parseDesignLog(line).events)).proposals[0]!
    expect(proposal.raisedFrom).toBeUndefined()
  })

  test("the record is kept to the newest questions, and a broken one is empty", () => {
    const store = memory()
    const ledger = askerLedger(() => store, 2)
    for (const k of ["D1", "D2", "D3"]) ledger.remember(PATH, k, NOW.toISOString(), "p")
    expect(JSON.parse(store.items.get(ASKER_LEDGER_KEY)!)).toHaveLength(2)
    store.items.set(ASKER_LEDGER_KEY, "{rotto")
    const event = { k: "D1", at: NOW.toISOString(), fromPane: "p" }
    expect(ledger.vouch(PATH, [event])[0]!.fromPane).toBeUndefined()
    expect(askerLedger(() => undefined).vouch(PATH, [event])[0]!.fromPane).toBeUndefined()
  })
})
