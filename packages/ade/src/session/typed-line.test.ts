import { describe, expect, test } from "bun:test"

import { isTyping, typedAfter } from "./typed-line"

const typeAll = (chunks: string[]): number => chunks.reduce((pending, chunk) => typedAfter(pending, chunk), 0)

describe("typedAfter", () => {
  test("counts what the user typed and not yet sent", () => {
    expect(typeAll(["g", "i", "t", " ", "s", "t"])).toBe(6)
    expect(isTyping(typeAll(["g"]))).toBe(true)
  })

  test("Enter empties it: what was typed has gone", () => {
    expect(typeAll(["git st", "\r"])).toBe(0)
    expect(typeAll(["git st", "\n"])).toBe(0)
    expect(isTyping(0)).toBe(false)
  })

  test("Ctrl+C, Ctrl+U and Escape throw the line away", () => {
    for (const key of ["\u0003", "\u0015", "\u001b"]) {
      expect(typeAll(["una frase", key])).toBe(0)
    }
  })

  test("backspace gives characters back, and never goes below zero", () => {
    expect(typeAll(["ab", "\u007f"])).toBe(1)
    expect(typeAll(["a", "\u007f", "\u007f", "\u007f"])).toBe(0)
    expect(typeAll(["ab", "\u0008\u0008"])).toBe(0)
  })

  /*
   * The arrow keys of someone reading their own history would otherwise
   * leave the pane dirty for ever: the pane would stop taking mail with
   * nothing typed in it.
   */
  test("a key sequence is neither typing nor sending", () => {
    expect(typedAfter(0, "\u001b[A")).toBe(0)
    expect(typedAfter(4, "\u001b[D")).toBe(4)
    expect(typedAfter(4, "\u001b[3~")).toBe(4)
  })

  /** The newline a TUI inserts without submitting keeps the line dirty. */
  test("Alt+Enter adds a line instead of sending it", () => {
    expect(typedAfter(3, "\u001b\r")).toBe(4)
  })

  test("a declared paste counts as typed, markers apart", () => {
    expect(typedAfter(0, "\u001b[200~ciao\u001b[201~")).toBe(4)
  })

  test("nothing typed, nothing changes", () => {
    expect(typedAfter(2, "")).toBe(2)
    expect(typedAfter(2, "\u0000")).toBe(2)
  })
})
