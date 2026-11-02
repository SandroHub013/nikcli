import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { translate } from "../i18n"
import { STATE_IDS } from "../grid/pane-state"

/*
 * Review area 2, MEDIO: the status dot's title and aria-label were
 * `Stato: ${…}` with an Italian word, so in English a screen reader said
 * «Stato: a lavoro». The word now comes from the one state list
 * (`paneState.*`), which has both languages (`grid/state-list.test.ts`).
 */
test("the status icon is named in the language of the window", () => {
  for (const id of STATE_IDS) {
    const it = translate("it", `paneState.${id}` as never)
    const en = translate("en", `paneState.${id}` as never)
    expect(translate("it", "sidebar.agentStatus", it)).toBe(`Stato: ${it}`)
    const english = translate("en", "sidebar.agentStatus", en)
    expect(english).toBe(`Status: ${en}`)
    expect(english).not.toContain(it)
  }
  expect(translate("en", "sidebar.agentStatus", translate("en", "paneState.off"))).toBe("Status: Suspended")
})

test("lint: the sidebar writes no status label by hand", () => {
  const source = readFileSync(join(import.meta.dir, "sidebar.tsx"), "utf8")
  expect(source).not.toContain("`Stato: ")
})
