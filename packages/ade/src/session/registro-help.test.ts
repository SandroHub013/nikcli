import { expect, test } from "bun:test"
import { USAGE } from "./mailbox"

/* `ade-msg help` says how to write in the registers (polish-aaa, point 3; TEAM.md, «Come si scrive nei registri»). */
test("the registro help names the new fields and the five writing rules", () => {
  for (const field of ["question", "why", "recommend {option, because}", "facts", "effect", "cost", "risk", "keeps", "changes"]) {
    expect(USAGE).toContain(field)
  }
  expect(USAGE).toContain("context resta obbligatorio")
  expect(USAGE).toContain("recommend.option")
  expect(USAGE).toContain("niente codici")
  expect(USAGE).toContain("mai «(consigliata)»")
  expect(USAGE).toContain("cosa cambia per l'utente")
  expect(USAGE).toContain("niente note che scadono")
  expect(USAGE).toContain("context al massimo 3 frasi")
  // Every line of the help still fits a terminal.
  for (const line of USAGE.split("\n")) expect(line.length).toBeLessThanOrEqual(120)
})
