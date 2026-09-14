import { describe, expect, test } from "bun:test"
import { transcriptToMarkdown, type TranscriptMessage } from "./transcript-markdown"

const user = (text: string): TranscriptMessage => ({ role: "user", parts: [{ type: "text", text }] })
const assistant = (text: string, tools: string[] = []): TranscriptMessage => ({
  role: "assistant",
  parts: [
    ...tools.map((tool) => ({ type: "tool", tool, state: { status: "completed" } })),
    ...(text ? [{ type: "text", text }] : []),
  ],
})

describe("transcriptToMarkdown", () => {
  test("quotes the user and leaves the answer as prose", () => {
    const out = transcriptToMarkdown({ messages: [user("fix the bug"), assistant("Fixed it.")] })
    expect(out).toBe("> fix the bug\n\nFixed it.\n")
  })

  test("quotes every line of a multi-line prompt, blank lines included", () => {
    const out = transcriptToMarkdown({ messages: [user("one\n\ntwo")] })
    expect(out).toBe("> one\n>\n> two\n")
  })

  test("markdown inside a prompt cannot restructure the document", () => {
    // A pasted "# heading" in a prompt would otherwise become a section of
    // whatever issue this is pasted into.
    const out = transcriptToMarkdown({ messages: [user("# not a heading")] })
    expect(out.startsWith("> # not a heading")).toBe(true)
  })

  test("names the tools rather than transcribing their output", () => {
    const out = transcriptToMarkdown({ messages: [assistant("Done.", ["read", "edit"])] })
    expect(out).toBe("*read, edit*\n\nDone.\n")
  })

  test("collapses a run of the same tool", () => {
    const out = transcriptToMarkdown({ messages: [assistant("Done.", ["read", "read", "read", "edit"])] })
    expect(out).toContain("read ×3, edit")
  })

  test("counts a run correctly past two", () => {
    const out = transcriptToMarkdown({ messages: [assistant("", ["read", "read", "read", "read", "read"])] })
    expect(out).toContain("read ×5")
  })

  test("leaves out tools that did not complete", () => {
    const message: TranscriptMessage = {
      role: "assistant",
      parts: [
        { type: "tool", tool: "edit", state: { status: "running" } },
        { type: "text", text: "Working." },
      ],
    }
    expect(transcriptToMarkdown({ messages: [message] })).toBe("Working.\n")
  })

  test("skips a message with nothing to say", () => {
    const empty: TranscriptMessage = { role: "assistant", parts: [] }
    expect(transcriptToMarkdown({ messages: [user("hi"), empty] })).toBe("> hi\n")
  })

  test("puts the title first when there is one", () => {
    expect(transcriptToMarkdown({ title: "My session", messages: [user("hi")] })).toBe("# My session\n\n> hi\n")
  })

  test("ends with exactly one newline, however the conversation ended", () => {
    for (const messages of [[user("a")], [assistant("b")], [user("a"), assistant("b\n\n\n")]]) {
      const out = transcriptToMarkdown({ messages })
      expect(out.endsWith("\n")).toBe(true)
      expect(out.endsWith("\n\n")).toBe(false)
    }
  })

  test("an empty session produces an empty document, not a stray newline pile", () => {
    expect(transcriptToMarkdown({ messages: [] })).toBe("\n")
  })
})

describe("tool names that share a prefix", () => {
  const tools = (names: string[]): TranscriptMessage => ({
    role: "assistant",
    parts: names.map((tool) => ({ type: "tool", tool, state: { status: "completed" } })),
  })

  test("a tool is not folded into one whose name it merely prefixes", () => {
    // `startsWith` alone rendered this as "search ×2": the first tool erased and
    // the count invented. MCP servers routinely expose `x` beside `x_y`.
    expect(transcriptToMarkdown({ messages: [tools(["search_files", "search"])] })).toBe(
      "*search_files, search*\n",
    )
  })

  test("the reverse order was already right and stays right", () => {
    expect(transcriptToMarkdown({ messages: [tools(["search", "search_files"])] })).toBe(
      "*search, search_files*\n",
    )
  })

  test("a run after a prefix-sharing neighbour counts only itself", () => {
    expect(transcriptToMarkdown({ messages: [tools(["grep_all", "grep", "grep"])] })).toBe("*grep_all, grep ×2*\n")
  })

  test("a genuine run still collapses", () => {
    expect(transcriptToMarkdown({ messages: [tools(["read", "read", "read"])] })).toBe("*read ×3*\n")
  })

  test("a run resumes counting from the right number past two", () => {
    expect(transcriptToMarkdown({ messages: [tools(["read", "read", "read", "read"])] })).toBe("*read ×4*\n")
  })
})
