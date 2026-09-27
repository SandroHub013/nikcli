import { describe, expect, test } from "bun:test"
import { answerItem, recipientFor, resolveDeliveryTarget } from "../decisions/delivery"
import { parseDecisionLog } from "../decisions/log"
import { foldDecisions } from "../decisions/state"
import { recipientFor as designRecipientFor } from "../design/delivery"
import { parseDesignLog } from "../design/log"
import { foldProposals } from "../design/state"
import { registerWrite, type RegisterWriteDeps } from "./register-write"

/*
 * notifiche-design: the answer goes back to whoever asked. The register kept
 * only the asking pane's title (`by`), so the answer went to the session
 * chosen in «Risposte a», whoever had asked. ADE now writes the pane and its
 * agent into the event, and the fold and the delivery read them.
 */
const NOW = new Date("2026-09-27T12:00:00.000Z")

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
  return { deps, text: () => text }
}

const opened = (k: string) =>
  JSON.stringify({ k, title: "Tasto", options: [{ label: "A" }, { label: "B" }], fromPane: "finto", agent: "finto" })

describe("the asking pane in the register", () => {
  test("ADE writes the sender's pane and agent, whatever the JSON says", async () => {
    const register = file({ fromPane: "p-lucia", agent: "agy" })
    const reply = await registerWrite(register.deps, { register: "decisioni", op: "aperta", text: opened("D1") })
    expect(reply).toStartWith("ok: D1")
    const [event] = parseDecisionLog(register.text()).events
    expect(event).toMatchObject({ k: "D1", by: "Lucia", fromPane: "p-lucia", agent: "agy" })
    const decision = foldDecisions(parseDecisionLog(register.text()).events, NOW).decisions[0]!
    expect(decision.raisedFrom).toBe("p-lucia")
    expect(decision.raisedAgent).toBe("agy")
  })

  test("a design proposal keeps them too", async () => {
    const register = file({ fromPane: "p-opus", agent: "claude-code" })
    const text = JSON.stringify({
      k: "DS1",
      title: "Tasto",
      variants: [
        { name: "A", description: "", preview: "" },
        { name: "B", description: "", preview: "" },
      ],
    })
    expect(await registerWrite(register.deps, { register: "design", op: "aperta", text })).toStartWith("ok: DS1")
    const proposal = foldProposals(parseDesignLog(register.text()).events).proposals[0]!
    expect([proposal.raisedFrom, proposal.raisedAgent]).toEqual(["p-opus", "claude-code"])
  })

  test("written by hand, without ADE: no pane, as before", async () => {
    const register = file()
    await registerWrite(register.deps, { register: "decisioni", op: "aperta", text: opened("D1") })
    const decision = foldDecisions(parseDecisionLog(register.text()).events, NOW).decisions[0]!
    expect(decision.raisedFrom).toBeUndefined()
  })
})

describe("the answer goes to the pane that asked", () => {
  const sessions = [
    { id: "p-master", title: "Master", running: true },
    { id: "p-lucia", title: "Lucia", running: true },
    { id: "p-chiusa", title: "Chiusa", running: false },
  ]
  const chosen = { state: "pronta", id: "p-master", title: "Master" } as const

  test("the asker while it runs; the chosen session when it is closed or unknown", () => {
    expect(recipientFor("p-lucia", sessions, chosen)).toEqual({ state: "pronta", id: "p-lucia", title: "Lucia" })
    expect(recipientFor("p-chiusa", sessions, chosen)).toBe(chosen)
    expect(recipientFor(undefined, sessions, chosen)).toBe(chosen)
    expect(designRecipientFor("p-lucia", sessions, { state: "non scelta" })).toMatchObject({ id: "p-lucia" })
  })

  test("the queued answer is addressed to the asker, and delivered there", () => {
    const asked = { k: "D1", raisedFrom: "p-lucia" }
    const item = answerItem(".ade/decisions.jsonl", asked, NOW.toISOString(), 1)
    expect(resolveDeliveryTarget(item, sessions, chosen)).toEqual({ id: "p-lucia", title: "Lucia" })
    const old = answerItem(".ade/decisions.jsonl", { k: "D2" }, NOW.toISOString(), 1)
    expect(resolveDeliveryTarget(old, sessions, chosen)).toEqual({ id: "p-master", title: "Master" })
  })
})

test("an asker that closed does not send the answer to another pane with its title", () => {
  const sessions = [
    { id: "p-master", title: "Master", running: true },
    { id: "p-altra", title: "Lucia", running: true },
  ]
  const item = answerItem(".ade/decisions.jsonl", { k: "D1", raisedFrom: "p-lucia" }, NOW.toISOString(), 1)
  expect(resolveDeliveryTarget(item, sessions, { state: "pronta", id: "p-master", title: "Master" })).toEqual({
    id: "p-master",
    title: "Master",
  })
})

test("lint: the workbench writes the sender's pane and queues answers with answerItem", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(import.meta.dir, "../surface/workbench.tsx"),
    "utf8",
  )
  expect(source).toContain("fromPane: sender ? message.from : undefined,")
  expect(source).toContain("enqueue(decisionsOutbox(), answerItem(path, decision, event.at, Date.now()))")
  expect(source).toContain("enqueueDesign(designOutbox(), designAnswerItem(path, proposal, event.at, Date.now()))")
})
