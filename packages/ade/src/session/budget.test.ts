import { describe, expect, test } from "bun:test"
import {
  USAGE,
  budgetOf,
  formatElapsed,
  formatRequest,
  formatTimeNote,
  parseMessage,
  parseOpenRequests,
  requestsTable,
  shouldNudge,
  updatesAnsweredBy,
  timeNoteDue,
  type OpenRequest,
} from "./mailbox"

const ask = (budget: unknown) => JSON.stringify({ kind: "ask", to: "B", text: "prova D73", from: "a", budget })

describe("the budget on a request (D73)", () => {
  test("parseMessage takes 60, 1200 and 14400 seconds", () => {
    for (const budget of [60, 1200, 14400]) expect(parseMessage(ask(budget))).toMatchObject({ kind: "ask", budget })
    expect(parseMessage(JSON.stringify({ kind: "spawn", agent: "claude", text: "t", from: "a", budget: 600 }))).toMatchObject({ budget: 600 })
  })

  test("parseMessage ignores 59, 14401, \"20m\" and 1.5, and keeps the request", () => {
    for (const budget of [59, 14401, "20m", 1.5, "1200", null]) {
      const message = parseMessage(ask(budget))
      expect(message).toMatchObject({ kind: "ask", to: "B", text: "prova D73" })
      expect(message && "budget" in message).toBe(false)
    }
    expect(budgetOf(60)).toBe(60)
    expect(budgetOf(59)).toBeUndefined()
  })

  test("a send carries no budget", () => {
    const message = parseMessage(JSON.stringify({ kind: "send", to: "B", text: "t", from: "a", budget: 600 }))
    expect(message && "budget" in message).toBe(false)
  })

  test("formatRequest with a budget says it in the header; without, the line is today's", () => {
    const withBudget = formatRequest("171-ab", "trova i test lenti", undefined, { budget: 1200 })
    expect(withBudget).toMatch(/^\[Richiesta 171-ab da [^\]]* · budget 1200s\]: trova i test lenti/)
    const without = formatRequest("171-ab", "trova i test lenti", undefined)
    expect(without).toBe(formatRequest("171-ab", "trova i test lenti", undefined, {}))
    expect(without).not.toContain("budget")
    expect(without.replace(/^\[Richiesta 171-ab da [^\]]*\]/, "")).toBe(withBudget.replace(/^\[Richiesta 171-ab da [^\]]*\]/, ""))
  })

  test("formatElapsed counts from deliveredAt if there is one, else from at, in whole seconds", () => {
    expect(formatElapsed({ at: 0, deliveredAt: 10_000, budget: 1200 }, 350_400)).toBe("elapsed 340s / 1200s")
    expect(formatElapsed({ at: 0, budget: 1200 }, 339_600)).toBe("elapsed 340s / 1200s")
    expect(formatElapsed({ at: 0 }, 339_600)).toBeUndefined()
  })

  test("timeNoteDue gives 1 at half, 2 at the end, each once, and nothing without a budget", () => {
    const request = { at: 0, deliveredAt: 0, budget: 120 }
    expect(timeNoteDue(request, 59_000)).toBeUndefined()
    expect(timeNoteDue(request, 60_000)).toBe(1)
    expect(timeNoteDue({ ...request, timeNotes: 1 }, 90_000)).toBeUndefined()
    expect(timeNoteDue({ ...request, timeNotes: 1 }, 120_000)).toBe(2)
    expect(timeNoteDue({ ...request, timeNotes: 2 }, 900_000)).toBeUndefined()
    // After a restart past the end with neither given: only the end is said.
    expect(timeNoteDue(request, 500_000)).toBe(2)
    expect(timeNoteDue({ at: 0 }, 900_000)).toBeUndefined()
  })

  test("the two notes say the time, and the last one how to close or ask for more", () => {
    const request = { id: "171-ab", at: 0, budget: 1200 }
    expect(formatTimeNote(request, 600_000, 1)).toBe("[Tempo] 171-ab: elapsed 600s / 1200s")
    expect(formatTimeNote(request, 1_200_000, 2)).toBe(
      '[Tempo] 171-ab: elapsed 1200s / 1200s, budget finito: chiudi con ade-msg reply 171-ab, o chiedi tempo con ade-msg update 171-ab decisione "<motivo>"',
    )
  })

  test("ade-msg status shows the elapsed time beside a request with a budget, and nothing beside one without", () => {
    const base: OpenRequest = { id: "171-ab", kind: "ask", from: "", to: "", at: 0, brief: "prova" }
    const table = requestsTable([{ ...base, budget: 1200 }, { ...base, id: "172-cd" }], [], () => "in corso", 125_000)
    expect(table).toContain("2m05s (elapsed 125s / 1200s)")
    expect(table.split("\n")[1]).not.toContain("elapsed")
  })

  test("a request saved before the budget existed still reads, whole and unchanged", () => {
    // A line of the saved store as the previous build wrote it: no budget, no timeNotes.
    const old =
      '[{"id":"1790000000000-ab12cd34","kind":"ask","from":"n1","to":"n2","at":1790000000000,"brief":"trova i test lenti","deliveredAt":1790000000500,"via":"digitata","nudges":1,"nudgedAt":1790000300000}]'
    const [request] = parseOpenRequests(old)
    expect(request).toEqual(JSON.parse(old)[0])
    expect(timeNoteDue(request, 1790009999999)).toBeUndefined()
    expect(formatElapsed(request, 1790009999999)).toBeUndefined()
  })

  test("a saved budget that is not one is dropped, never the request", () => {
    const saved = JSON.stringify([{ id: "a1", kind: "ask", from: "", to: "b", at: 1, brief: "x", budget: "20m", timeNotes: 1 }])
    expect(parseOpenRequests(saved)).toEqual([{ id: "a1", kind: "ask", from: "", to: "b", at: 1, brief: "x" }])
    const kept = JSON.stringify([{ id: "a1", kind: "ask", from: "", to: "b", at: 1, brief: "x", budget: 600, timeNotes: 1 }])
    expect(parseOpenRequests(kept)).toEqual([{ id: "a1", kind: "ask", from: "", to: "b", at: 1, brief: "x", budget: 600, timeNotes: 1 }])
  })

  test("with a draft open the time note does not go and is not given; once the line is empty it goes once", () => {
    const request: Pick<OpenRequest, "at" | "deliveredAt" | "budget" | "timeNotes"> = { at: 0, deliveredAt: 0, budget: 120 }
    // What the workbench does each round: type and mark only what is due.
    const round = (now: number, typing: boolean) => {
      const due = timeNoteDue(request, now, typing)
      if (due) request.timeNotes = due
      return due
    }
    expect(round(61_000, true)).toBeUndefined()
    expect(request.timeNotes).toBeUndefined()
    expect(round(62_000, true)).toBeUndefined()
    expect(round(63_000, false)).toBe(1)
    expect(round(64_000, false)).toBeUndefined()
    expect(request.timeNotes).toBe(1)
  })

  test("with a draft open the reminder does not go either; with the line empty it does (Architect, same defect)", () => {
    const request: OpenRequest = { id: "171-ab", kind: "ask", from: "", to: "b", at: 0, brief: "x" }
    const quiet = { running: true, permissionPending: false, lastOutputAt: 10_000 }
    expect(shouldNudge(request, { ...quiet, typing: true }, 900_000)).toBe(false)
    expect(shouldNudge(request, { ...quiet, typing: false }, 900_000)).toBe(true)
    expect(shouldNudge(request, quiet, 900_000)).toBe(true)
  })

  test("the last note is neutral for a request that is blocked or waits on a decision", () => {
    const request = { id: "171-ab", at: 0, budget: 1200 }
    for (const state of ["bloccata", "decisione"] as const) {
      const line = formatTimeNote({ ...request, update: { state, text: "serve una chiave", at: 1 } }, 1_200_000, 2)
      expect(line).toBe("[Tempo] 171-ab: elapsed 1200s / 1200s, budget finito")
      expect(line).not.toContain("chiudi")
    }
  })

  test("only a note from the caller answers a blocked request; a new ask to the same session does not clear it", () => {
    const blocked = { id: "old", from: "p1", to: "p2", update: { state: "bloccata" as const, text: "serve una chiave", at: 1 } }
    const other = { id: "other", from: "p3", to: "p2", update: { state: "decisione" as const, text: "x", at: 1 } }
    const requests = [blocked, other]
    // What the Architect saw: a later `ask` from the same caller cleared the block, and the old request got reminders.
    expect(updatesAnsweredBy(requests, { kind: "ask", from: "p1" }, "p2")).toEqual([])
    expect(updatesAnsweredBy(requests, { kind: "send", from: "p1" }, "p2")).toEqual([blocked])
    expect(updatesAnsweredBy(requests, { kind: "send", from: "p1" }, "p9")).toEqual([])
  })

  test("the help names --budget and warns against it on security reviews and releases", () => {
    expect(USAGE).toContain("--budget <sec>")
    expect(USAGE).toContain("MAI su revisioni di sicurezza né su release")
  })
})
