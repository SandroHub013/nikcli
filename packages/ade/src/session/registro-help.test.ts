import { expect, test } from "bun:test"
import { USAGE } from "./mailbox"

/* `ade-msg help` says how to write in the registers (polish-aaa, point 3; TEAM.md, «Come si scrive nei registri»). */
test("the registro help names the new fields and the six writing rules", () => {
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
  // The Architect's two lines: accents, and a design recommendation names the whole variant.
  expect(USAGE).toContain("6) scrivi con")
  expect(USAGE).toContain("gli accenti")
  expect(USAGE).toContain("il nome intero della variante, per esempio «1 · Vetro»")
  // Every line of the help still fits a terminal.
  for (const line of USAGE.split("\n")) expect(line.length).toBeLessThanOrEqual(120)
})
