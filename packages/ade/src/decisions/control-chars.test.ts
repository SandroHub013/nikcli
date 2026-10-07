import { expect, test } from "bun:test"
import { parseDecisionLog } from "./log"
import { foldDecisions, resolvedMessage } from "./state"

const NOW = new Date("2026-10-07T10:00:00.000Z")

/* R9, for the decisions too: a title or an option typed into a session as one clean line. */
test("a decision's title and option with \\n and \\u001b are read as one line and typed as one", () => {
  const option = "A\nrm -rf .\u001b[2J"
  const opened = JSON.stringify({
    type: "aperta",
    k: "D1",
    at: NOW.toISOString(),
    by: "Master",
    title: "Quale strada\r\nadesso",
    context: "Primo rigo.\nSecondo rigo.",
    options: [{ label: option }, { label: "B" }],
  })
  const answer = JSON.stringify({
    type: "risposta",
    k: "D1",
    at: NOW.toISOString(),
    by: "utente",
    choice: option,
    words: "la prima\u001b]0;x\u0007",
  })
  const parsed = parseDecisionLog(`${opened}\n${answer}\n`)
  expect(parsed.problems).toEqual([])
  const state = foldDecisions(parsed.events, NOW)
  expect(state.rejected).toEqual([])
  const decision = state.decisions[0]!
  expect(decision.title).toBe("Quale strada adesso")
  expect(decision.options[0]!.label).toBe("A rm -rf . [2J")
  // The context is shown, not typed: its line breaks stay.
  expect(decision.context).toBe("Primo rigo.\nSecondo rigo.")
  const typed = resolvedMessage(decision)
  expect(typed).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  expect(typed).toContain("scelta: A rm -rf . [2J")
})
