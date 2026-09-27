import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { translate } from "../i18n"
import { mapAgentStatus } from "./workspace-tree"

/*
 * Review area 2, MEDIO: the status dot's title and aria-label were
 * `Stato: ${…}` with the Italian word of `mapAgentStatus`, so in English a
 * screen reader said «Stato: a lavoro».
 */
test("the status dot is named in the language of the window", () => {
  for (const status of ["idle", "working", "waiting", "done", "error"] as const) {
    const word = mapAgentStatus(status)
    expect(translate("it", "sidebar.agentStatus", word)).toBe(`Stato: ${word}`)
    const english = translate("en", "sidebar.agentStatus", word)
    expect(english.startsWith("Status: ")).toBe(true)
    expect(english).not.toContain(word)
  }
  expect(translate("en", "sidebar.agentStatus", mapAgentStatus("idle", true))).toBe("Status: suspended")
})

test("lint: the sidebar writes no status label by hand", () => {
  const source = readFileSync(join(import.meta.dir, "sidebar.tsx"), "utf8")
  expect(source).not.toContain("`Stato: ")
})
