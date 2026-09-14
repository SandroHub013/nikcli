import { describe, expect, test } from "bun:test"
import { createMarkedParser } from "./marked"
import { renderIncremental, stableBoundary, type StablePrefix } from "./markdown-split"

const { parse } = createMarkedParser()

/**
 * The only property that matters: splitting must be invisible.
 *
 * `parse(prefix) + parse(tail)` has to equal `parse(whole)` byte for byte, for
 * every prefix a stream can produce. These documents are the constructs that
 * break a naive "split at the last blank line" — a blank line does not end a
 * list, a table, or an indented code block, and `===` on the next line reaches
 * back and rewrites the paragraph above it.
 */
const CORPUS: Array<[string, string]> = [
  ["raw text block: pre", "Before.\n\n<pre>\nline one\n\nline two\n</pre>\n\nAfter.\n"],
  ["raw text block: script", "Before.\n\n<script>\nvar a = 1;\n\nvar b = 2;\n</script>\n\nAfter.\n"],
  ["raw text block: style", "Before.\n\n<style>\na{}\n\nb{}\n</style>\n\nAfter.\n"],
  ["raw text block: textarea", "Before.\n\n<textarea>\nfoo\n\nbar\n</textarea>\n\nAfter.\n"],
  ["unclosed html container", "Warning.\n\n<div class=\"callout\">\nFirst line.\n\nSecond line.\n</div>\n\nAfter.\n"],
  ["crlf fenced code", "Before.\r\n\r\n```ts\r\nconst x = 1\r\n\r\nconst y = 2\r\n```\r\n\r\nAfter.\r\n"],
  ["crlf list continuation", "Intro.\r\n\r\n- first\r\n\r\n  still first\r\n\r\nAfter.\r\n"],
  ["link definition indented in a list", "See [r].\n\nPara.\n\n- a\n  - b\n\n    [r]: https://x.test\n\nEnd.\n"],
  ["plain paragraphs", "First paragraph here.\n\nSecond paragraph here.\n\nThird one.\n"],
  ["tight list", "Intro line.\n\n- one\n- two\n- three\n\nAfter the list.\n"],
  ["loose list", "Intro line.\n\n- one\n\n- two\n\n- three\n\nAfter.\n"],
  ["ordered list restarting", "Intro.\n\n1. one\n\n2. two\n\n3. three\n\nAfter.\n"],
  ["nested list", "Intro.\n\n- outer\n  - inner\n\n  - inner two\n\n- outer two\n\nDone.\n"],
  ["table", "Before.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter.\n"],
  ["blockquote", "Before.\n\n> quoted line\n\n> still quoted\n\nAfter.\n"],
  ["setext heading", "Some paragraph.\n\nA heading\n=========\n\nBody text.\n"],
  ["setext heading with dashes", "Some paragraph.\n\nA heading\n---------\n\nBody text.\n"],
  ["thematic break", "Above.\n\n---\n\nBelow.\n"],
  ["atx headings", "# Title\n\nBody.\n\n## Section\n\nMore body.\n"],
  ["fenced code", "Before.\n\n```ts\nconst x = 1\n\nconst y = 2\n```\n\nAfter.\n"],
  ["fence with blank lines inside", "Before.\n\n```\n\n\n\n```\n\nAfter.\n"],
  ["tilde fence containing backticks", "Before.\n\n~~~\n```\nnot a fence\n```\n~~~\n\nAfter.\n"],
  ["indented code block", "Before.\n\n    indented one\n\n    indented two\n\nAfter.\n"],
  ["html block", "Before.\n\n<div>\n\n  <span>x</span>\n\n</div>\n\nAfter.\n"],
  ["link reference definitions", "See [the docs][d] and [more][m].\n\n[d]: https://example.com\n\n[m]: https://example.org\n\nEnd.\n"],
  ["reference defined after use", "Read [this][ref] carefully.\n\nAnother paragraph.\n\n[ref]: https://example.com\n"],
  ["inline formatting across blocks", "Some *emphasis* here.\n\nAnd `code` plus **bold**.\n\nDone.\n"],
  ["trailing blank lines", "Only one paragraph.\n\n\n\n"],
  ["no trailing newline", "One paragraph.\n\nSecond with no newline at the end"],
  ["empty", ""],
  ["single line", "just text"],
  ["starts blank", "\n\nAfter leading blanks.\n"],
  ["consecutive fences", "```js\na\n```\n\n```py\nb\n```\n\nEnd.\n"],
  ["list then fence", "- item\n\n```ts\nconst a = 1\n```\n\nEnd.\n"],
  ["math", "Before $x+y$ here.\n\nDisplay:\n\n$$a^2 + b^2$$\n\nAfter.\n"],
  ["task list", "Todo:\n\n- [ ] one\n\n- [x] two\n\nDone.\n"],
  ["strikethrough and autolink", "See ~~this~~ and https://example.com here.\n\nNext paragraph.\n"],
  ["hard break from trailing spaces", "line one  \nline two\n\nafter\n"],
  ["hard break from backslash", "line one\\\nline two\n\nafter\n"],
  ["entity references", "AT&amp;T and &lt;tag&gt; here.\n\nMore &copy; text.\n"],
  ["CRLF line endings", "First para.\r\n\r\nSecond para.\r\n"],
  ["display math spanning blocks", "Before.\n\n$$\na^2 + b^2\n$$\n\nAfter.\n"],
  ["inline math with blank line between", "Cost is $5 here.\n\nAnd $x + y$ there.\n"],
  ["nested blockquote", "Top.\n\n> outer\n> > inner\n\n> still outer\n\nEnd.\n"],
  ["lazy continuation", "> quoted start\nlazy continuation line\n\nAfter.\n"],
  ["list item with blank line inside", "Intro.\n\n- first\n\n  still first item\n\n- second\n\nAfter.\n"],
  ["ordered list with paren", "Intro.\n\n1) one\n\n2) two\n\nAfter.\n"],
  ["table with alignment row", "Before.\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\nAfter.\n"],
  ["heading immediately after fence", "```js\nx\n```\n# Heading\n\nBody.\n"],
  ["indented fence", "Intro.\n\n  ```ts\n  const a = 1\n  ```\n\nAfter.\n"],
  ["unclosed html comment", "<!--\n\na"],
  ["comment opened then closed later", "<!-- note\n\nstill comment --> after\n\nBody.\n"],
  ["display math reopened", "$$\n\n\n$$"],
  ["display math across blocks", "$$\n\n$$\nx = 1\n$$\n"],
  ["inline dollars are not display math", "Costs $5 and $7 today.\n\nNext.\n"],
]

describe("stableBoundary", () => {
  test.each(CORPUS)("%s: every prefix splits without changing the output", async (_name, document) => {
    // Every prefix a stream can produce, one character at a time. Character
    // granularity matters: a boundary decision that is only correct on whole
    // lines would still ship a wrong frame mid-line.
    for (let length = 0; length <= document.length; length++) {
      const text = document.slice(0, length)
      const boundary = stableBoundary(text)
      if (boundary === 0) continue

      expect(boundary).toBeLessThanOrEqual(text.length)
      const [whole, prefix, tail] = await Promise.all([
        parse(text),
        parse(text.slice(0, boundary)),
        parse(text.slice(boundary)),
      ])
      expect(`${_name} @${length}: ${prefix}${tail}`).toBe(`${_name} @${length}: ${whole}`)
    }
  })

  test("a document with a link reference definition is never split", () => {
    expect(stableBoundary("Use [a][r].\n\nMore text.\n\n[r]: https://example.com\n")).toBe(0)
  })

  test("no boundary is reported from inside an unterminated fence", () => {
    const text = "Intro.\n\n```ts\nconst a = 1\n\nconst b = 2\n"
    const boundary = stableBoundary(text)
    expect(boundary).toBeLessThanOrEqual(text.indexOf("```"))
  })

  test("the boundary advances as the document grows, so segments are parsed once", () => {
    let previous = 0
    for (const text of ["a", "a\n\n", "a\n\nb", "a\n\nb\n\n", "a\n\nb\n\nc"]) {
      const boundary = stableBoundary(text)
      expect(boundary).toBeGreaterThanOrEqual(previous)
      previous = boundary
    }
    expect(previous).toBeGreaterThan(0)
  })
})

describe("renderIncremental", () => {
  /** Replays a document one character at a time, carrying the cache forward. */
  async function stream(document: string, render: (markdown: string) => Promise<string>) {
    let prefix: StablePrefix | undefined
    const frames: string[] = []
    let rendered = 0
    const counting = async (markdown: string) => {
      rendered += markdown.length
      return render(markdown)
    }
    for (let length = 0; length <= document.length; length++) {
      const result = await renderIncremental({ text: document.slice(0, length), cached: prefix, render: counting })
      prefix = result.prefix
      frames.push(result.html)
    }
    return { frames, rendered }
  }

  test.each(CORPUS)("%s: every frame matches a full render", async (_name, document) => {
    const { frames } = await stream(document, parse)
    for (let length = 0; length <= document.length; length++) {
      expect(`${_name} @${length}: ${frames[length]}`).toBe(`${_name} @${length}: ${await parse(document.slice(0, length))}`)
    }
  })

  test("re-renders far less text than a full parse of every frame", async () => {
    const document = CORPUS.find(([name]) => name === "plain paragraphs")![1]
    const { rendered } = await stream(document, async (markdown) => markdown)
    const full = Array.from({ length: document.length + 1 }, (_, i) => i).reduce((sum, i) => sum + i, 0)
    // The saving is the point of the whole exercise, so it is asserted, not assumed.
    expect(rendered).toBeLessThan(full / 2)
  })

  test("drops the cache when the text stops being an extension of it", async () => {
    const first = await renderIncremental({ text: "one\n\ntwo", cached: undefined, render: parse })
    expect(first.prefix).toBeDefined()
    // A rewind replaces the message rather than extending it.
    const second = await renderIncremental({ text: "different\n\nentirely", cached: first.prefix, render: parse })
    expect(second.html).toBe(await parse("different\n\nentirely"))
  })

  test("a link reference definition arriving late invalidates the cache", async () => {
    const before = await renderIncremental({ text: "Use [a][r].\n\nMore.\n\n", cached: undefined, render: parse })
    expect(before.prefix).toBeDefined()
    const after = await renderIncremental({
      text: "Use [a][r].\n\nMore.\n\n[r]: https://example.com\n",
      cached: before.prefix,
      render: parse,
    })
    expect(after.prefix).toBeUndefined()
    expect(after.html).toBe(await parse("Use [a][r].\n\nMore.\n\n[r]: https://example.com\n"))
  })
})
