import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { questionHints } from "@tui/util/question-hints"

/* Review of the UI, N27: the question's footer was hand-rolled text, a fourth style of hint beside the footer hints. */
const labels = (state: Parameters<typeof questionHints>[0]) => questionHints(state).map((h) => `${h.keys} ${h.label}`)

describe("questionHints", () => {
  test("a single question: select, enter submits, esc dismisses; no tabs", () => {
    expect(labels({ single: true, confirm: false, multi: false })).toEqual(["↑↓ select", "enter submit", "esc dismiss"])
  })

  test("several questions: tab switches, enter confirms", () => {
    expect(labels({ single: false, confirm: false, multi: false })).toEqual([
      "⇆ tab switch",
      "↑↓ select",
      "enter confirm",
      "esc dismiss",
    ])
  })

  test("a multiple-choice question: enter toggles", () => {
    expect(labels({ single: false, confirm: false, multi: true })).toContain("enter toggle")
  })

  test("the confirm tab: nothing to select, enter submits", () => {
    expect(labels({ single: false, confirm: true, multi: false })).toEqual(["⇆ tab switch", "enter submit", "esc dismiss"])
  })
})

describe("the question screen", () => {
  test("draws its hints with the shared footer row", () => {
    const src = readFileSync(join(import.meta.dir, "../../../../tui/src/routes/session/question.tsx"), "utf8")
    expect(src).toContain("<FooterHintList hints={hints()} />")
    expect(src).not.toContain('<span style={{ fg: theme.foreground.muted }}>dismiss</span>')
  })
})
