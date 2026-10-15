import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Review of the UI, N12: «Fork» was translated «Dirotta» (a diversion, not a branch), and the Italian placeholders
 * ended in three dots.
 */
const it = readFileSync(join(import.meta.dir, "../../../tui/src/i18n/it.ts"), "utf8")

describe("the Italian catalog's wording", () => {
  test("a fork is «Biforca»", () => {
    expect(it).not.toContain("Dirotta")
    expect(it).toContain('"session.message.fork": "Biforca"')
    expect(it).toContain('"session.cmd.forkFromMessage": "Biforca dal messaggio"')
  })

  test("its prompts end in «…», not three dots", () => {
    expect(it).toContain('"prompt.placeholder.ask": \'Chiedi qualsiasi cosa… "{{example}}"\'')
    expect(it).toContain('"prompt.placeholder.shell": \'Esegui un comando… "{{example}}"\'')
    expect(it).not.toMatch(/[A-Za-zàèéìòù]\.\.\.[ "']/)
  })
})
