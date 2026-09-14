import { describe, expect, test } from "bun:test"
import { pendingSummary, pendingText, queuedEntries, type PendingEntry } from "./pending-queue"

const entry = (over: Partial<PendingEntry> = {}): PendingEntry => ({
  id: "p1",
  delivery: "queue",
  createdAt: 1,
  data: { parts: [{ type: "text", text: "hello" }] },
  ...over,
})

describe("pendingSummary", () => {
  test("shows the text the user typed", () => {
    expect(pendingSummary(entry())).toBe("hello")
  })

  test("joins several text parts and collapses the whitespace between them", () => {
    const parts = [
      { type: "text", text: "  fix   this:\n" },
      { type: "text", text: "\n and that " },
    ]
    expect(pendingSummary(entry({ data: { parts } }))).toBe("fix this: and that")
  })

  test("does not leave a space hanging before the ellipsis", () => {
    // The existing case cuts inside a run of x's, so the trim was never reached
    // and could be deleted invisibly: real text would read "fix the bug …".
    const text = `${"fix the login bug ".repeat(20)}`
    const out = pendingSummary(entry({ data: { parts: [{ type: "text", text }] } }), 20)
    expect(out).not.toContain(" …")
  })

  test("the default keeps roughly a line, not the whole message", () => {
    // Every other case passes an explicit max, so the default could be anything.
    const long = "y".repeat(500)
    expect(pendingSummary(entry({ data: { parts: [{ type: "text", text: long }] } }))).toHaveLength(120)
  })

  test("truncates on a boundary rather than mid-scroll", () => {
    const long = "x".repeat(400)
    const out = pendingSummary(entry({ data: { parts: [{ type: "text", text: long }] } }), 20)
    expect(out).toHaveLength(20)
    expect(out.endsWith("…")).toBe(true)
  })

  test("does not truncate what already fits", () => {
    expect(pendingSummary(entry({ data: { parts: [{ type: "text", text: "short" }] } }), 20)).toBe("short")
  })

  test("summarises a message that is only attachments rather than showing nothing", () => {
    const parts = [{ type: "file" }, { type: "image" }]
    expect(pendingSummary(entry({ data: { parts } }))).toBe("2 attachments")
    expect(pendingSummary(entry({ data: { parts: [{ type: "file" }] } }))).toBe("1 attachment")
  })

  test("survives a shape it did not expect", () => {
    expect(pendingSummary(entry({ data: undefined }))).toBe("(empty)")
    expect(pendingSummary(entry({ data: { parts: [] } }))).toBe("(empty)")
    expect(pendingSummary(entry({ data: { parts: [{ type: "text" }] } }))).toBe("(empty)")
    expect(pendingSummary(entry({ data: { parts: [{ type: "text", text: "   " }] } }))).toBe("(empty)")
  })
})

describe("queuedEntries", () => {
  test("lists what is waiting, oldest first", () => {
    const list = [entry({ id: "b", createdAt: 2 }), entry({ id: "a", createdAt: 1 })]
    expect(queuedEntries(list).map((x) => x.id)).toEqual(["a", "b"])
  })

  test("leaves out messages already being steered into the running turn", () => {
    // They arrive within moments, so calling them "waiting" is wrong on screen.
    const list = [entry({ id: "q" }), entry({ id: "s", delivery: "steer" })]
    expect(queuedEntries(list).map((x) => x.id)).toEqual(["q"])
  })

  test("an empty list stays empty rather than throwing", () => {
    expect(queuedEntries([])).toEqual([])
  })

  test("does not mutate the list it was given", () => {
    const list = [entry({ id: "b", createdAt: 2 }), entry({ id: "a", createdAt: 1 })]
    queuedEntries(list)
    expect(list.map((x) => x.id)).toEqual(["b", "a"])
  })
})

describe("pendingText", () => {
  test("returns the words the user typed, unchanged", () => {
    expect(pendingText(entry({ data: { parts: [{ type: "text", text: "  fix this  " }] } }))).toBe("fix this")
  })

  test("does not truncate — this is the text going back for editing", () => {
    const long = "x".repeat(500)
    expect(pendingText(entry({ data: { parts: [{ type: "text", text: long }] } }))).toHaveLength(500)
  })

  test("joins several text parts without inventing separators", () => {
    const parts = [{ type: "text", text: "one " }, { type: "text", text: "two" }]
    expect(pendingText(entry({ data: { parts } }))).toBe("one two")
  })

  test("returns nothing for a message that was only attachments", () => {
    // They are not carried in the row, so a placeholder would be text the user
    // has to delete before typing.
    expect(pendingText(entry({ data: { parts: [{ type: "file" }] } }))).toBe("")
    expect(pendingText(entry({ data: undefined }))).toBe("")
  })

  test("keeps the newlines a multi-line message had", () => {
    const parts = [{ type: "text", text: "line one\nline two" }]
    expect(pendingText(entry({ data: { parts } }))).toBe("line one\nline two")
  })
})
