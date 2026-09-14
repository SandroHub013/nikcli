import { describe, expect, test } from "bun:test"
import { MAX_TEXT, formatDelivery, parseMessage, resolveTarget, sessionsTable } from "./mailbox"

const panes = [
  { id: "n1-0", title: "Sessione 1 — claude-code", agent: "claude-code", status: "idle" },
  { id: "n2-1", title: "Sessione 2 — codex", agent: "codex", status: "working" },
  { id: "n3-2", title: "Sessione 3 — claude-code", agent: "claude-code", status: "idle" },
]

describe("parseMessage", () => {
  test("what the scripts write, BOM included", () => {
    expect(parseMessage('﻿{"from":"n2-1","to":"claude","text":"ciao"}')).toEqual({
      from: "n2-1",
      to: "claude",
      text: "ciao",
    })
  })

  test("no target or no text is not a message", () => {
    expect(parseMessage('{"from":"a","to":"","text":"x"}')).toBeUndefined()
    expect(parseMessage('{"from":"a","to":"b","text":"  "}')).toBeUndefined()
    expect(parseMessage("not json")).toBeUndefined()
  })
})

describe("resolveTarget", () => {
  test("by id, by number, by exact title", () => {
    expect(resolveTarget(panes, "n2-1")).toEqual({ pane: panes[1] })
    expect(resolveTarget(panes, "#3")).toEqual({ pane: panes[2] })
    expect(resolveTarget(panes, "sessione 2 — codex")).toEqual({ pane: panes[1] })
  })

  test("codex can reach claude by the agent's name when there is one", () => {
    const single = [panes[0]!, panes[1]!]
    expect(resolveTarget(single, "claude", "n2-1")).toEqual({ pane: panes[0] })
  })

  test("two claude sessions are an error that lists them, never a guess", () => {
    const result = resolveTarget(panes, "claude", "n2-1")
    expect("error" in result && result.error).toContain("usa il numero")
  })

  test("a loose match never picks the sender itself", () => {
    // Session 1 asks for "claude": the only other claude is session 3.
    expect(resolveTarget(panes, "claude", "n1-0")).toEqual({ pane: panes[2] })
  })

  test("nothing matching says what does exist", () => {
    const result = resolveTarget(panes, "gemini")
    expect("error" in result && result.error).toContain("1 Sessione 1")
    expect("error" in resolveTarget(panes, "9")).toBe(true)
  })
})

describe("formatDelivery", () => {
  test("arrives on one line, with the way to answer", () => {
    const line = formatDelivery({ from: "n2-1", to: "claude", text: "riga uno\nriga due" }, panes[1])
    expect(line).toBe(
      '[Messaggio da "Sessione 2 — codex" (codex)]: riga uno riga due — per rispondere: ade-msg send n2-1 "<testo>"',
    )
  })

  test("escape sequences cannot become keystrokes in the other terminal", () => {
    const line = formatDelivery({ from: "", to: "x", text: "ok[2J" }, undefined)
    expect(line).toBe("[Messaggio da una sessione ADE]: ok[2J")
  })

  test("a very long text is cut", () => {
    const line = formatDelivery({ from: "", to: "x", text: "a".repeat(MAX_TEXT + 50) }, undefined)
    expect(line.endsWith("… [troncato]")).toBe(true)
  })
})

test("sessionsTable lists numbers, ids and titles, and how to send", () => {
  const table = sessionsTable(panes)
  expect(table).toContain("1  n1-0  claude-code  idle     Sessione 1 — claude-code")
  expect(table).toContain("ade-msg send")
})
