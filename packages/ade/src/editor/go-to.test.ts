import { describe, expect, test } from "bun:test"
import { goToDue, showTextFor, type GoTo } from "./go-to"
import { offsetOfLine } from "./buffer"

/** The editor's goTo effect, run again on every change as Solid runs it: with each goTo and each keystroke. */
function editor(text: string) {
  const state = { text, cursor: 0, done: undefined as GoTo | undefined, target: undefined as GoTo | undefined }
  const effect = () => {
    if (!goToDue(state.target, state.done, true)) return
    state.cursor = offsetOfLine(state.text, state.target!.line)
    state.done = state.target
  }
  return {
    state,
    goTo(target: GoTo) {
      state.target = target
      effect()
    },
    type(ch: string) {
      state.text = state.text.slice(0, state.cursor) + ch + state.text.slice(state.cursor)
      state.cursor += ch.length
      effect()
    },
  }
}

const FILE = '{\n  "name": "ade",\n  "version": "0.7.7"\n}\n'

describe("goToDue", () => {
  test("typing after a goTo writes in order and moves the cursor forward", () => {
    const e = editor(FILE)
    e.goTo({ line: 3, at: 1 })
    const start = offsetOfLine(FILE, 3)
    e.type("x")
    e.type("y")
    e.type("z")
    expect(e.state.text.split("\n")[2]).toBe('xyz  "version": "0.7.7"')
    expect(e.state.cursor).toBe(start + 3)
  })

  test("a second click on the same link brings the cursor back to the line", () => {
    const e = editor(FILE)
    e.goTo({ line: 3, at: 1 })
    e.type("x")
    e.goTo({ line: 3, at: 2 })
    expect(e.state.cursor).toBe(offsetOfLine(e.state.text, 3))
  })

  test("a goTo to another line moves the cursor there", () => {
    const e = editor(FILE)
    e.goTo({ line: 3, at: 1 })
    e.goTo({ line: 2, at: 2 })
    expect(e.state.cursor).toBe(offsetOfLine(FILE, 2))
  })

  test("a new goTo turns a preview to text; the same goTo leaves the reader's choice", () => {
    const first = { line: 3, at: 1 }
    expect(showTextFor(false, { line: 3, at: 2 }, first)).toBe(true)
    expect(showTextFor(false, first, undefined)).toBe(true)
    expect(showTextFor(false, first, first)).toBe(false)
    expect(showTextFor(false, undefined, first)).toBe(false)
  })

  test("waits for the text before carrying a goTo out", () => {
    expect(goToDue({ line: 3, at: 1 }, undefined, false)).toBe(false)
    expect(goToDue({ line: 3, at: 1 }, undefined, true)).toBe(true)
    expect(goToDue(undefined, undefined, true)).toBe(false)
  })
})
