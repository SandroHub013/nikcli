import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setLocalePreference } from "../i18n"
import { approvalAction, approvalLine } from "./approval-signal"
import { visibleText } from "./visible-text"

setLocalePreference("it")

/* P2-3: a command is shown to be decided with what is hidden in it written out. */
describe("visibleText", () => {
  test("the direction marks, the zero-width characters and the controls are written out", () => {
    expect(visibleText("rm -rf ‮fsd/‬")).toBe("rm -rf ⟨U+202E⟩fsd/⟨U+202C⟩")
    expect(visibleText("a​b⁦c⁩d﻿e")).toBe("a⟨U+200B⟩b⟨U+2066⟩c⟨U+2069⟩d⟨U+FEFF⟩e")
    expect(visibleText("ls\u0007\u001B[31m")).toBe("ls⟨U+0007⟩⟨U+001B⟩[31m")
    expect(visibleText("a\u007Fb\u0085c")).toBe("a⟨U+007F⟩b⟨U+0085⟩c")
  })

  test("a command is otherwise the same: accents, quotes, the newline and the tab a command really has", () => {
    const command = "echo « è » 'x'\n\tls -la"
    expect(visibleText(command)).toBe(command)
    expect(visibleText("")).toBe("")
  })

  test("the list and the bell show it written out, and the data is not changed", () => {
    const patterns = "rm -rf ‮fsd/"
    const one = { botName: "alfa", permission: "bash", patterns }
    expect(approvalAction(one)).toContain("⟨U+202E⟩")
    expect(approvalAction(one)).not.toContain("‮")
    expect(approvalLine(one)).not.toContain("‮")
    expect(one.patterns).toContain("‮")
  })

  test("lint: the card in the thread, the list, the bell and the phone use it", () => {
    const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8")
    expect(read("bots.tsx")).toContain("visibleText(patterns())")
    expect(read("waiting-list.tsx")).toContain("visibleText(waiting.patterns)")
    expect(read("approval-signal.ts")).toContain("visibleText(waiting.patterns.trim())")
    expect(read("gateway/approval.ts")).toContain("visibleText(patterns.trim())")
  })
})
