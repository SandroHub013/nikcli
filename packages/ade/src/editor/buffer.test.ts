import { describe, expect, test } from "bun:test"
import {
  openBuffer,
  editBuffer,
  markSaved,
  revertBuffer,
  saveBlockedReason,
  lineCount,
  positionOf,
  offsetOfLine,
  eolOf,
  toLf,
  withEol,
} from "./buffer"

describe("editor buffer model", () => {
  test("openBuffer initializes clean state from loaded file", () => {
    const buf = openBuffer({
      path: "/src/main.rs",
      text: "fn main() {}\n",
      truncated: false,
    })

    expect(buf.path).toBe("/src/main.rs")
    expect(buf.saved).toBe("fn main() {}\n")
    expect(buf.draft).toBe("fn main() {}\n")
    expect(buf.dirty).toBe(false)
    expect(buf.truncated).toBe(false)
  })

  test("openBuffer preserves truncated flag", () => {
    const buf = openBuffer({
      path: "/huge.log",
      text: "line 1\n",
      truncated: true,
    })

    expect(buf.truncated).toBe(true)
    expect(buf.dirty).toBe(false)
  })

  test("editBuffer updates draft and tracks dirty state", () => {
    const original = openBuffer({
      path: "config.json",
      text: '{"ok": true}',
      truncated: false,
    })

    const edited = editBuffer(original, '{"ok": false}')
    expect(edited.draft).toBe('{"ok": false}')
    expect(edited.saved).toBe('{"ok": true}')
    expect(edited.dirty).toBe(true)

    // Editing back to original saved text resets dirty to false
    const restored = editBuffer(edited, '{"ok": true}')
    expect(restored.dirty).toBe(false)
  })

  test("markSaved updates saved baseline and recalculates dirty", () => {
    const buf = editBuffer(openBuffer({ path: "test.txt", text: "hello", truncated: false }), "hello world")
    expect(buf.dirty).toBe(true)

    const saved = markSaved(buf, "hello world")
    expect(saved.saved).toBe("hello world")
    expect(saved.draft).toBe("hello world")
    expect(saved.dirty).toBe(false)
  })

  test("revertBuffer discards modifications and restores saved state", () => {
    const buf = editBuffer(openBuffer({ path: "test.txt", text: "initial", truncated: false }), "modified text")
    expect(buf.dirty).toBe(true)

    const reverted = revertBuffer(buf)
    expect(reverted.draft).toBe("initial")
    expect(reverted.saved).toBe("initial")
    expect(reverted.dirty).toBe(false)
  })

  test("saveBlockedReason: truncated buffer is NEVER allowed to save", () => {
    // Crucial safety rule: saving a truncated buffer would overwrite and destroy the remaining file on disk.
    const truncatedBuf = editBuffer(
      openBuffer({ path: "large.bin", text: "partial data", truncated: true }),
      "modified partial data",
    )
    expect(truncatedBuf.dirty).toBe(true)
    const reason = saveBlockedReason(truncatedBuf)
    expect(reason).toBeDefined()
    expect(typeof reason).toBe("string")
    expect(reason).toContain("troncato")
  })

  test("saveBlockedReason: clean buffer has no changes to save", () => {
    const cleanBuf = openBuffer({
      path: "test.txt",
      text: "no changes",
      truncated: false,
    })
    const reason = saveBlockedReason(cleanBuf)
    expect(reason).toBeDefined()
    expect(reason).toContain("Nessuna modifica")
  })

  test("saveBlockedReason: permits save only when dirty and not truncated", () => {
    const dirtyBuf = editBuffer(openBuffer({ path: "test.txt", text: "clean", truncated: false }), "dirty")
    expect(saveBlockedReason(dirtyBuf)).toBeUndefined()
  })

  /*
   * Writing to disk is a round trip, and the user keeps typing during it.
   * `saveFile` used to capture the buffer before the await and put that same
   * object back afterwards, which threw away every character typed in between
   * and then marked the buffer clean — so the text was gone from the editor
   * and the pane showed nothing left to save.
   */
  test("markSaved on a buffer edited during the write keeps the newer draft", () => {
    const opened = openBuffer({ path: "a.ts", text: "vecchio", truncated: false })
    const whenSaveStarted = editBuffer(opened, "nuovo")

    // The save writes "nuovo"; meanwhile the user types one more character.
    const whileWriting = editBuffer(whenSaveStarted, "nuovo!")
    const afterSave = markSaved(whileWriting, whenSaveStarted.draft)

    expect(afterSave.draft).toBe("nuovo!")
    expect(afterSave.saved).toBe("nuovo")
    // Still dirty, because the last character was never written.
    expect(afterSave.dirty).toBe(true)
  })

  test("markSaved on an untouched buffer leaves nothing to save", () => {
    const edited = editBuffer(openBuffer({ path: "a.ts", text: "x", truncated: false }), "y")
    const afterSave = markSaved(edited, edited.draft)

    expect(afterSave.dirty).toBe(false)
    expect(afterSave.saved).toBe("y")
  })

  test("lineCount counts lines accurately", () => {
    expect(lineCount("")).toBe(1)
    expect(lineCount("one line")).toBe(1)
    expect(lineCount("line 1\nline 2")).toBe(2)
    expect(lineCount("line 1\nline 2\n")).toBe(3)
    expect(lineCount("a\nb\nc\nd")).toBe(4)
  })

  test("positionOf returns 1-based line and column", () => {
    const sample = "hello\nworld\n!"

    // Start of document
    expect(positionOf(sample, 0)).toEqual({ line: 1, column: 1 })

    // Within first line
    expect(positionOf(sample, 3)).toEqual({ line: 1, column: 4 })

    // On newline character after 'hello' (index 5)
    expect(positionOf(sample, 5)).toEqual({ line: 1, column: 6 })

    // First char of second line 'w' (index 6)
    expect(positionOf(sample, 6)).toEqual({ line: 2, column: 1 })

    // Second line 'r' (index 8)
    expect(positionOf(sample, 8)).toEqual({ line: 2, column: 3 })

    // Third line '!' (index 12)
    expect(positionOf(sample, 12)).toEqual({ line: 3, column: 1 })

    // Beyond document end clamps to end
    expect(positionOf(sample, 999)).toEqual({ line: 3, column: 2 })

    // Negative offset clamps to start
    expect(positionOf(sample, -10)).toEqual({ line: 1, column: 1 })
  })
})

describe("offsetOfLine (S76)", () => {
  const text = "uno\ndue\ntre"

  test("line 1 starts at 0", () => {
    expect(offsetOfLine(text, 1)).toBe(0)
  })

  test("a later line starts after its newline", () => {
    expect(offsetOfLine(text, 3)).toBe(8)
  })

  test("past the end is the start of the last line", () => {
    expect(offsetOfLine(text, 99)).toBe(8)
  })
})

/*
 * Full review 2026-10-06, ui 1: a CRLF file became LF on the first edit, because the textarea hands
 * back LF. The whole file was rewritten and git's diff covered every line.
 */
describe("a file with CRLF line ends", () => {
  const crlf = "one\r\ntwo\r\nthree\r\n"
  const open = (text: string) => openBuffer({ path: "/a.txt", text, truncated: false })

  test("opens with LF and remembers the line ending", () => {
    const buf = open(crlf)
    expect(buf.draft).toBe("one\ntwo\nthree\n")
    expect(buf.saved).toBe("one\ntwo\nthree\n")
    expect(buf.eol).toBe("\r\n")
    expect(buf.dirty).toBe(false)
  })

  test("the first keystroke is the only change: undoing it is clean again", () => {
    const buf = open(crlf)
    const typed = editBuffer(buf, "one!\ntwo\nthree\n")
    expect(typed.dirty).toBe(true)
    // The textarea's own value, after the edit is undone: LF, equal to what was opened.
    expect(editBuffer(typed, buf.draft).dirty).toBe(false)
  })

  test("what is written has the file's line ending back, so only the edited line differs", () => {
    const buf = editBuffer(open(crlf), "one!\ntwo\nthree\n")
    expect(withEol(buf.draft, buf.eol)).toBe("one!\r\ntwo\r\nthree\r\n")
  })

  test("a LF file stays LF, and a lone CR is read as a line end", () => {
    const lf = open("a\nb\n")
    expect(lf.eol).toBe("\n")
    expect(withEol(lf.draft, lf.eol)).toBe("a\nb\n")
    expect(open("a\rb").draft).toBe("a\nb")
  })

  test("a mixed file takes the line ending most of it has", () => {
    expect(eolOf("a\r\nb\r\nc\n")).toBe("\r\n")
    expect(eolOf("a\nb\nc\r\n")).toBe("\n")
    expect(eolOf("no line end")).toBe("\n")
  })

  test("the disk's text is compared with the saved one in LF", () => {
    expect(toLf(crlf)).toBe(open(crlf).saved)
  })
})
