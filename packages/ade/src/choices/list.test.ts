import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseDecisionLog } from "../decisions/log"
import { foldDecisions } from "../decisions/state"
import { parseDesignLog } from "../design/log"
import { foldProposals } from "../design/state"
import { choiceCounts, choiceItems, waitedFor } from "./list"

/*
 * notifiche-design: the bar had a button for decisions and one for design,
 * each opening its own window. One button, «Da scegliere», counts both and
 * lists both, and each entry says what it is, who asked and how long ago.
 */
const NOW = new Date("2026-09-27T12:00:00.000Z")
const line = (event: object) => JSON.stringify(event)

const decisions = foldDecisions(
  parseDecisionLog(
    [
      line({
        type: "aperta",
        k: "D1",
        at: "2026-09-27T11:00:00.000Z",
        by: "Lucia",
        title: "Quale font",
        options: [{ label: "A" }, { label: "B" }],
      }),
      line({
        type: "aperta",
        k: "D2",
        at: "2026-09-27T09:00:00.000Z",
        by: "Master",
        title: "Già risposta",
        options: [{ label: "A" }, { label: "B" }],
      }),
      line({ type: "risposta", k: "D2", at: "2026-09-27T10:00:00.000Z", by: "utente", choice: "A", words: "A" }),
    ].join("\n"),
  ).events,
  NOW,
).decisions
const proposals = foldProposals(
  parseDesignLog(
    line({
      type: "aperta",
      k: "DS1",
      at: "2026-09-27T10:30:00.000Z",
      by: "Opus",
      title: "La barra",
      variants: [
        { name: "Sobria", description: "", preview: "" },
        { name: "Banco", description: "", preview: "" },
      ],
    }),
  ).events,
).proposals

describe("«Da scegliere»", () => {
  test("one list of what is open, decisions and design, the longest waiting first", () => {
    expect(choiceItems(decisions, proposals)).toEqual([
      { kind: "design", k: "DS1", title: "La barra", by: "Opus", openedAt: "2026-09-27T10:30:00.000Z" },
      { kind: "decision", k: "D1", title: "Quale font", by: "Lucia", openedAt: "2026-09-27T11:00:00.000Z" },
    ])
  })

  test("the button counts both registers", () => {
    expect(choiceCounts({ waiting: 1, queued: 2, discarded: 0 }, { waiting: 3, queued: 0, discarded: 1 })).toEqual({
      waiting: 4,
      queued: 2,
      discarded: 1,
    })
  })

  test("how long an entry has waited", () => {
    expect(waitedFor("2026-09-27T11:59:40.000Z", NOW)).toBe("adesso")
    expect(waitedFor("2026-09-27T11:48:00.000Z", NOW)).toBe("12 min fa")
    expect(waitedFor("2026-09-27T09:00:00.000Z", NOW)).toBe("3 h fa")
    expect(waitedFor("2026-09-26T11:00:00.000Z", NOW)).toBe("1 giorno fa")
  })

  test("lint: the sheet lists every entry with its kind, its asker and its age, and opens it on a press", () => {
    const sheet = readFileSync(join(import.meta.dir, "choices-sheet.tsx"), "utf8")
    expect(sheet).toContain('<Sheet component="choices-sheet"')
    expect(sheet).toContain('t("choices.asked", item.by, waitedFor(item.openedAt, now()))')
    expect(sheet).toContain("onClick={() => props.onPick(item)}")
  })

  test("lint: the palette's two commands and the voice's «apri le decisioni» open the one list", () => {
    const workbench = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    expect(workbench).toContain('} else if (id === "decisions.open" || id === "design.open") {')
    const opened = workbench.slice(workbench.indexOf('id === "decisions.open" || id === "design.open"'))
    expect(opened.slice(0, 200)).toContain("setChoicesOpen(true)")
    expect(workbench).toContain("start={choiceStart()}")
  })
})
