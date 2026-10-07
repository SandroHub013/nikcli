import { expect, test } from "bun:test"
import { USAGE, USAGE_DECISIONI, USAGE_DESIGN } from "./mailbox"

/* T2: `ade-msg help design` is the format in 15 lines at most, with an example; the general help one line per command. */
test("the design help fits in 15 lines and says the folder, the pages and the wait", () => {
  const lines = USAGE_DESIGN.split("\n")
  expect(lines.length).toBeLessThanOrEqual(15)
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(120)
  for (const part of [
    ".ade/design/<k>/",
    "proposta.json",
    '"file": "1.html"',
    "al massimo 6 da 2 MB",
    "ade-size",
    "--attendi",
    "scelta: 2 · Carta",
    "altro giro",
    "ade-msg design attendi <k>",
  ])
    expect(USAGE_DESIGN).toContain(part)
  // Gone from the help: the note that expired, the recommendation repeated in context, url as the main road.
  for (const text of [USAGE, USAGE_DESIGN, USAGE_DECISIONI]) {
    expect(text).not.toContain("finché la carta nuova non è in")
    expect(text).not.toContain("va ripetuta in una riga all'inizio di context")
  }
  expect(USAGE).not.toContain("claude.ai")
  expect(USAGE).toContain("ade-msg design proponi <cartella>")
  expect(USAGE).toContain("ade-msg help decisioni")
})

/* `ade-msg help` says how to write in the registers (polish-aaa, point 3; TEAM.md, «Come si scrive nei registri»). */
test("the registro help names the new fields and the six writing rules", () => {
  for (const field of [
    "question",
    "why",
    "recommend {option, because}",
    "facts",
    "effect",
    "cost",
    "risk",
    "keeps",
    "changes",
  ]) {
    expect(USAGE_DECISIONI).toContain(field)
  }
  expect(USAGE_DECISIONI).toContain("context resta obbligatorio")
  expect(USAGE_DECISIONI).toContain("recommend.option")
  expect(USAGE_DECISIONI).toContain("niente codici")
  expect(USAGE_DECISIONI).toContain("mai «(consigliata)»")
  expect(USAGE_DECISIONI).toContain("cosa cambia per l'utente")
  expect(USAGE_DECISIONI).toContain("niente note che scadono")
  expect(USAGE_DECISIONI).toContain("context al massimo 3 frasi")
  // The Architect's two lines: accents, and a design recommendation names the whole variant.
  expect(USAGE_DECISIONI).toContain("6) scrivi con")
  expect(USAGE_DECISIONI).toContain("gli accenti")
  expect(USAGE_DECISIONI).toContain("il nome intero della variante, per esempio «1 · Vetro»")
  // Every line of the help still fits a terminal.
  for (const line of [USAGE, USAGE_DECISIONI].join("\n").split("\n")) expect(line.length).toBeLessThanOrEqual(120)
})
