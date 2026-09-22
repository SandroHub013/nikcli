import { describe, expect, test } from "bun:test"

import { isTyping, submittedSince, typedAfter, type TypedLine } from "./typed-line"

const typeAll = (chunks: string[], from: TypedLine | undefined = undefined): TypedLine | undefined =>
  chunks.reduce((line, chunk, index) => typedAfter(line, chunk, 1_000 + index), from)

const pending = (line: TypedLine | undefined) => line?.pending ?? 0

describe("typedAfter", () => {
  test("counts what the user typed and not yet sent", () => {
    expect(pending(typeAll(["g", "i", "t", " ", "s", "t"]))).toBe(6)
    expect(isTyping(typeAll(["g"]))).toBe(true)
    expect(isTyping(undefined)).toBe(false)
  })

  test("Enter empties it: what was typed has gone", () => {
    expect(typeAll(["git st", "\r"])).toBeUndefined()
    expect(typeAll(["git st", "\n"])).toBeUndefined()
  })

  test("Ctrl+C throws the line away", () => {
    expect(typeAll(["una frase", "\u0003"])).toBeUndefined()
  })

  /*
   * One Escape closes a menu or interrupts the agent; the draft goes on the
   * second. Clearing on the first read a full line as empty.
   */
  test("Escape clears only when pressed twice", () => {
    expect(pending(typeAll(["una frase", "\u001b"]))).toBe(9)
    expect(typeAll(["una frase", "\u001b", "\u001b"])).toBeUndefined()
    // Anything between the two is not a double Escape.
    expect(pending(typeAll(["una frase", "\u001b", "x", "\u001b"]))).toBe(10)
    expect(pending(typeAll(["una frase", "\u001b", "\u001b[A", "\u001b"]))).toBe(9)
  })

  test("Ctrl+U is not trusted to empty the line", () => {
    // It kills to the start of the line: at mid-line the tail stays. Too
    // high heals on the next Enter; too low is the damage itself.
    expect(pending(typeAll(["una frase", "\u0015"]))).toBe(9)
  })

  test("backspace gives characters back, and never goes below zero", () => {
    expect(pending(typeAll(["ab", "\u007f"]))).toBe(1)
    expect(typeAll(["a", "\u007f", "\u007f", "\u007f"])).toBeUndefined()
    expect(typeAll(["ab", "\u0008\u0008"])).toBeUndefined()
  })

  /*
   * The arrow keys of someone reading their own history would otherwise
   * leave the pane dirty for ever: the pane would stop taking mail with
   * nothing typed in it.
   */
  test("a key sequence is neither typing nor sending", () => {
    expect(typedAfter(undefined, "\u001b[A", 5)).toBeUndefined()
    expect(pending(typedAfter({ pending: 4, at: 1 }, "\u001b[D", 5))).toBe(4)
    expect(pending(typedAfter({ pending: 4, at: 1 }, "\u001b[3~", 5))).toBe(4)
  })

  /** The newline a TUI inserts without submitting keeps the line dirty. */
  test("Alt+Enter adds a line instead of sending it", () => {
    expect(pending(typedAfter({ pending: 3, at: 1 }, "\u001b\r", 5))).toBe(4)
  })

  /*
   * A pasted block of code has newlines in it and is not sent by them: it
   * sits in the input box, the longest draft there is. Reading its newline
   * as Enter left exactly that draft unguarded.
   */
  test("a declared paste counts as typed, newlines included, and never submits", () => {
    expect(pending(typedAfter(undefined, "\u001b[200~ciao\u001b[201~", 5))).toBe(4)
    expect(pending(typedAfter({ pending: 2, at: 1 }, "\u001b[200~a\nb\nc\u001b[201~", 5))).toBe(7)
    expect(typedAfter(undefined, "\u001b[200~\u001b[201~", 5)).toBeUndefined()
  })

  test("nothing typed, nothing changes", () => {
    const line = { pending: 2, at: 1 }
    expect(typedAfter(line, "", 5)).toBe(line)
    expect(pending(typedAfter(line, "\u0000", 5))).toBe(2)
  })

  test("remembers when the last key arrived", () => {
    expect(typedAfter(undefined, "a", 42)?.at).toBe(42)
    expect(typedAfter({ pending: 1, at: 42 }, "\u001b[A", 43)?.at).toBe(43)
  })
})

describe("submittedSince", () => {
  /** The CLI's own hook is certain where the count is a guess. */
  test("a prompt submitted after the last key clears whatever was pending", () => {
    expect(submittedSince({ pending: 9, at: 100 }, 100)).toBeUndefined()
    expect(submittedSince({ pending: 9, at: 100 }, 150)).toBeUndefined()
  })

  test("a key after the submit is a new line, and stays", () => {
    const line = { pending: 3, at: 200 }
    expect(submittedSince(line, 150)).toBe(line)
    expect(submittedSince(undefined, 150)).toBeUndefined()
  })
})
