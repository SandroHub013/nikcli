import { describe, expect, test } from "bun:test"
import { DEFAULT_MAX_LINES, formatTerminalExcerpt, terminalExcerpt } from "./terminal-context"

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n")

describe("terminalExcerpt", () => {
  test("a selection is taken as it stands", () => {
    const result = terminalExcerpt({ selection: "  error: boom  ", scrollback: lines(200) })
    expect(result).toEqual({ text: "  error: boom", dropped: 0, source: "selection" })
  })

  test("a long selection is not truncated: the user already chose it", () => {
    const selection = lines(500)
    const result = terminalExcerpt({ selection, scrollback: "" })
    expect(result!.text.split("\n")).toHaveLength(500)
    expect(result!.dropped).toBe(0)
  })

  test("whitespace is not a selection", () => {
    expect(terminalExcerpt({ selection: "   \n  \n", scrollback: "output" })!.source).toBe("scrollback")
  })

  test("keeps the tail, because that is where a run fails", () => {
    const result = terminalExcerpt({ selection: "", scrollback: lines(100), maxLines: 10 })
    expect(result!.text).toBe(lines(100).split("\n").slice(-10).join("\n"))
    expect(result!.text.endsWith("line 100")).toBe(true)
    expect(result!.dropped).toBe(90)
  })

  test("reports what it dropped rather than trimming quietly", () => {
    expect(terminalExcerpt({ selection: "", scrollback: lines(61), maxLines: 60 })!.dropped).toBe(1)
    expect(terminalExcerpt({ selection: "", scrollback: lines(60), maxLines: 60 })!.dropped).toBe(0)
    expect(terminalExcerpt({ selection: "", scrollback: lines(3), maxLines: 60 })!.dropped).toBe(0)
  })

  test("strips the blank rows a terminal pads with, at both ends", () => {
    const result = terminalExcerpt({ selection: "", scrollback: "\n\n\nreal output\n\n\n\n" })
    expect(result!.text).toBe("real output")
    expect(result!.dropped).toBe(0)
  })

  test("an empty terminal has nothing to send", () => {
    expect(terminalExcerpt({ selection: "", scrollback: "" })).toBeUndefined()
    expect(terminalExcerpt({ selection: "", scrollback: "\n\n\n" })).toBeUndefined()
    expect(terminalExcerpt({ selection: "  ", scrollback: "   \n  " })).toBeUndefined()
  })

  test("the default keeps two screens, not the whole session", () => {
    const result = terminalExcerpt({ selection: "", scrollback: lines(5000) })
    expect(result!.text.split("\n")).toHaveLength(DEFAULT_MAX_LINES)
    expect(result!.dropped).toBe(5000 - DEFAULT_MAX_LINES)
  })
})

describe("formatTerminalExcerpt", () => {
  const excerpt = { text: "error: boom", dropped: 0, source: "selection" as const }

  test("fences the output so it is read as data, not as instructions", () => {
    const out = formatTerminalExcerpt({ excerpt, title: "Terminal" })
    expect(out).toContain("```\nerror: boom\n```")
    expect(out.startsWith("[Terminal]")).toBe(true)
  })


  test("says what was cut, so the agent does not explain the wrong error", () => {
    const out = formatTerminalExcerpt({ excerpt: { ...excerpt, dropped: 12 }, title: "Terminal" })
    expect(out).toContain("[12 earlier lines not shown]")
  })

  test("counts one dropped line in the singular", () => {
    const out = formatTerminalExcerpt({ excerpt: { ...excerpt, dropped: 1 }, title: "Terminal" })
    expect(out).toContain("[1 earlier line not shown]")
  })

  test("says nothing about truncation when nothing was truncated", () => {
    expect(formatTerminalExcerpt({ excerpt, title: "Terminal" })).not.toContain("not shown")
  })

  test.each([
    ["```", 4],
    ["````", 5],
    ["`inline`", 3],
    ["no backticks at all", 3],
    ["a ``` b ````` c", 6],
  ])("output containing %p is fenced with %i backticks", (text, expected) => {
    // A log that prints a fence would otherwise close the block early and the
    // rest would arrive as prose the agent acts on. CommonMark ends a fence only
    // on a run at least as long as the opener, so the opener has to be longer
    // than anything inside.
    const out = formatTerminalExcerpt({
      excerpt: { text: text as string, dropped: 0, source: "scrollback" },
      title: "Terminal",
    })
    const opener = out.split("\n").find((line) => /^`{3,}$/.test(line))!
    expect(opener).toBe("`".repeat(expected as number))
    // The block has to close, and only on a line that is the fence alone.
    expect(out.split("\n").filter((line) => line === opener)).toHaveLength(2)
  })

  test("the fenced block survives a markdown parse with its content intact", async () => {
    const { createMarkedParser } = await import("@nikcli-ai/ui/context/marked")
    const text = "before\n```\nafter"
    const html = await createMarkedParser().parse(
      formatTerminalExcerpt({ excerpt: { text, dropped: 0, source: "scrollback" }, title: "Terminal" }),
    )
    // Everything, the inner fence included, stays inside one code block.
    expect(html).toContain("after")
    expect(html.indexOf("<code")).toBeLessThan(html.indexOf("after"))
  })

})
