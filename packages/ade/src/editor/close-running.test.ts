import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createCloser } from "./closer"
import { NOT_FROM_TEXT_FIELDS } from "../keyboard/bindings"

/*
 * Review of the frontend, ALTO 6: Ctrl+W typed in a composer closed the pane
 * and ended the agent in it, with nothing to take it back.
 */

function setup(alive: Record<string, string>) {
  const closed: string[] = []
  const questions: { agent: string; answer: (yes: boolean) => void }[] = []
  const closer = createCloser({
    unsaved: () => undefined,
    ask: async () => true,
    closeNow: (id) => void closed.push(id),
    exists: () => true,
    running: (id) => alive[id],
    askRunning: (agent) => new Promise<boolean>((resolve) => questions.push({ agent, answer: resolve })),
  })
  return { closer, closed, questions }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("closing an agent at work (ALTO 6)", () => {
  test("from a shortcut, a running agent is ended only on a yes", async () => {
    const s = setup({ a: "Sessione 1 — nikcli" })
    expect(s.closer.close("a", { confirmRunning: true })).toBe(false)
    expect(s.questions.map((q) => q.agent)).toEqual(["Sessione 1 — nikcli"])
    s.questions[0]!.answer(false)
    await tick()
    expect(s.closed).toEqual([])
    expect(s.closer.close("a", { confirmRunning: true })).toBe(false)
    s.questions[1]!.answer(true)
    await tick()
    expect(s.closed).toEqual(["a"])
  })

  test("a pane with nothing running closes at once, and so does a close that is a decision already", () => {
    const s = setup({ a: "Sessione 1 — nikcli" })
    expect(s.closer.close("b", { confirmRunning: true })).toBe(true)
    // `ade-msg close` and the ✕: no question.
    expect(s.closer.close("a")).toBe(true)
    expect(s.closed).toEqual(["b", "a"])
    expect(s.questions).toEqual([])
  })

  test("lint: the keydown handler drops NOT_FROM_TEXT_FIELDS in a text field before running a command (ALTO 6)", () => {
    expect(NOT_FROM_TEXT_FIELDS.has("pane.close")).toBe(true)
    const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    const keys = source.slice(source.indexOf("const isInput = target.tagName"), source.indexOf("const handleKeyUp = "))
    expect(keys).toContain("NOT_FROM_TEXT_FIELDS.has(resolution.commandId)")
    // Checked before the command runs.
    expect(keys.indexOf("NOT_FROM_TEXT_FIELDS")).toBeLessThan(keys.indexOf("void runCommand("))
  })

  test("lint: the pane.close command closes with confirmRunning (ALTO 6)", () => {
    const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    const command = source.slice(
      source.indexOf('} else if (id === "pane.close") {'),
      source.indexOf('} else if (id === "pane.expand") {'),
    )
    expect(command).toContain("{ confirmRunning: true }")
  })
})
