import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { codeOf } from "../test-support/source-text"

import { isAnswerKey, isTyping, questionOpened, submittedSince, typedAfter, type TypedLine } from "./typed-line"

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
    expect(typeAll(["git st", "\r\n"])).toBeUndefined()
  })

  // Full review 2026-10-06, sessions 7: a new line in the draft is not a send.
  test("Ctrl+J and backslash-Enter add a line to the draft instead of sending it", () => {
    // Ctrl+J is `\n`: a new line in Claude Code's box.
    expect(pending(typeAll(["git st", "\n"]))).toBe(7)
    expect(isTyping(typeAll(["prima riga", "\n"]))).toBe(true)
    // `\` then Enter: the backslash becomes the new line, the draft keeps its length.
    const line = typeAll(["prima riga\\", "\r"])
    expect(pending(line)).toBe(11)
    expect(isTyping(line)).toBe(true)
    // Typed one key at a time, as a keyboard does.
    expect(pending(typeAll(["a", "b", "\\", "\r", "c"]))).toBe(4)
    // And the Enter after that does send.
    expect(typeAll(["prima riga\\", "\r", "seconda", "\r"])).toBeUndefined()
  })

  test("a backslash that is not the last thing typed does not turn Enter into a new line", () => {
    expect(typeAll(["a\\b", "\r"])).toBeUndefined()
    expect(typeAll(["a\\", "\u007f", "\r"])).toBeUndefined()
    expect(typeAll(["a\\", "\u001b[D", "\r"])).toBeUndefined()
  })

  test("a pasted block with LF newlines counts every line, and CRLF is one Enter", () => {
    expect(pending(typedAfter(undefined, "a\nb\nc", 5))).toBe(5)
    expect(pending(typedAfter(undefined, "uno\r\ndue", 5))).toBe(3)
    expect(typedAfter({ pending: 3, at: 1 }, "x\r\n", 5)).toBeUndefined()
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

  /*
   * Review area 2: an undeclared paste of `a\rb` sends `a` and leaves `b` in
   * the line. The count said nothing was there, and the next delivery's Enter
   * ran `b` with it.
   */
  test("an Enter in the middle of a chunk leaves what came after it pending", () => {
    expect(pending(typedAfter({ pending: 3, at: 1 }, "a\rb", 5))).toBe(1)
    expect(pending(typedAfter(undefined, "uno\r\ndue", 5))).toBe(3)
    expect(typedAfter({ pending: 3, at: 1 }, "a\r", 5)).toBeUndefined()
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

/*
 * Live test 2026-11-02, F2: «q» typed with no Enter into a menu on screen counted as a line begun, so every message to
 * the pane was held until the user pressed Enter, three minutes later.
 */
describe("a key typed into a menu on screen", () => {
  test("answers the menu: it is not a line begun, and mail is not held for it", () => {
    for (const key of ["q", "y", "2", " "]) {
      const line = typedAfter(undefined, key, 1_000, true)
      expect(isTyping(line)).toBe(false)
    }
  })

  test("the same key with no menu is a line begun, as before", () => {
    expect(isTyping(typedAfter(undefined, "q", 1_000, false))).toBe(true)
    expect(isTyping(typedAfter(undefined, "q", 1_000))).toBe(true)
  })

  /*
   * Review B1: xterm delivers typing one key at a time, so «every single key» was «every key»: the instruction typed
   * ahead during a long tool run, with the hook still saying `permission`, was all uncounted and the mail landed in it.
   */
  test("only the first key before an Enter is an answer: the second is a draft", () => {
    const first = typedAfter(undefined, "1", 1_000, true)
    expect(isTyping(first)).toBe(false)
    const typedAhead = ["c", "o", "n", "t"].reduce((line, key, index) => typedAfter(line, key, 2_000 + index, true), first)
    expect(isTyping(typedAhead)).toBe(true)
    expect(typedAhead?.pending).toBe(4)
  })

  test("a key on top of a draft begun before the menu counts, and the mail stays held", () => {
    const draft = typedAfter(undefined, "ciao come", 1_000)
    const after = typedAfter(draft, "y", 2_000, true)
    expect(isTyping(after)).toBe(true)
    expect(after?.pending).toBe(10)
  })

  test("an Enter after the answer clears it, and the next key is an answer again", () => {
    const answered = typedAfter(undefined, "y", 1_000, true)
    const sent = typedAfter(answered, String.fromCharCode(13), 2_000, true)
    expect(isTyping(typedAfter(sent, "n", 3_000, true))).toBe(false)
  })

  test("what counts as a key to read the screen for is one printable character", () => {
    for (const key of ["1", "y", " ", "é"]) expect([key, isAnswerKey(key)]).toEqual([key, true])
    const esc = String.fromCharCode(27)
    const cr = String.fromCharCode(13)
    const lf = String.fromCharCode(10)
    for (const data of ["", cr, lf, "ab", esc, `${esc}[A`, `${esc}[<0;10;5M`, String.fromCharCode(127), String.fromCharCode(3)])
      expect([data, isAnswerKey(data)]).toEqual([data, false])
  })

  test("only a single key is an answer: a paste or several characters into the menu count as typed", () => {
    expect(isTyping(typedAfter(undefined, "hello", 1_000, true))).toBe(true)
    expect(isTyping(typedAfter(undefined, "\u001b[200~pasted\u001b[201~", 1_000, true))).toBe(true)
  })

  test("an Enter into a menu still sends, and clears what was there", () => {
    const draft = typedAfter(undefined, "abc", 1_000)
    expect(typedAfter(draft, "\r", 2_000, true)).toBeUndefined()
  })
})

/*
 * Re-review B7: `answered` outlived the menu it answered, so the second one-key menu of the same turn counted as a draft and
 * every message to the pane was held, with a note about a line nobody had begun.
 */
describe("a new question", () => {
  test("is answered by its own first key, even when the last one was answered with no Enter between", () => {
    const first = typedAfter(undefined, "1", 1_000, true)
    expect(isTyping(first)).toBe(false)
    const second = typedAfter(questionOpened(first), "1", 2_000, true)
    expect(isTyping(second)).toBe(false)
    expect(isTyping(typedAfter(questionOpened(second), "2", 3_000, true))).toBe(false)
  })

  test("without a new question the second key is still a draft", () => {
    const first = typedAfter(undefined, "1", 1_000, true)
    expect(isTyping(typedAfter(first, "1", 2_000, true))).toBe(true)
  })

  test("leaves a real draft alone", () => {
    const draft = typedAfter(undefined, "ciao", 1_000)
    expect(questionOpened(draft)).toBe(draft)
    expect(questionOpened(undefined)).toBeUndefined()
  })
})

test("lint: a question opening, by the hook or by the screen, drops the last answer", () => {
  const workbench = codeOf(readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf-8"))
  const hook = workbench.slice(workbench.indexOf(codeOf('if (next === "waiting") {')))
  expect(hook.slice(0, 300)).toContain(codeOf("records.typed.update(paneId, questionOpened)"))
  const screen = workbench.slice(workbench.indexOf(codeOf("permissions.set(paneId, request)")))
  expect(screen.slice(0, 200)).toContain(codeOf("records.typed.update(paneId, questionOpened)"))
})

test("lint: the terminal asks whether a question is open before it counts a key", () => {
  const renderer = readFileSync(join(import.meta.dir, "../surface/pane-renderer.tsx"), "utf-8")
  expect(renderer).toContain("const menuOpen = isAnswerKey(data) && deps.menuOpen(current().id)")
  expect(renderer).toContain("typedAfter(line, data, Date.now(), menuOpen)")
  const workbench = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf-8")
  expect(workbench).toMatch(/promptAnswered,\r?\n\s+menuOpen: menuOnScreen,/)
})
