import { describe, expect, test } from "bun:test"
import { createMarkedParser } from "./marked"

/**
 * KaTeX, the shiki engine and @pierre/diffs are fetched on first use instead of
 * being bundled into the entry chunk. These exercise the deferred paths through
 * the real parser so a broken dynamic import fails here rather than at runtime.
 */
const { parse } = createMarkedParser()

describe("markdown parsing", () => {
  test("parses plain markdown", async () => {
    const html = await parse("# Title\n\nSome **bold** text.")
    expect(html).toContain("<h1")
    expect(html).toContain("<strong>bold</strong>")
  })

  test("rewrites links to open safely in a new tab", async () => {
    const html = await parse("[docs](https://example.com)")
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})

describe("deferred KaTeX", () => {
  test("renders inline math", async () => {
    const html = await parse("The value $x^2$ matters.")
    expect(html).toContain("katex")
    expect(html).not.toContain("$x^2$")
  })

  test("renders display math", async () => {
    const html = await parse("$$\\frac{a}{b}$$")
    expect(html).toContain("katex")
  })

  test("leaves prose without a dollar sign untouched by the math pass", async () => {
    const html = await parse("no math here")
    expect(html).not.toContain("katex")
  })
})

describe("deferred shiki engine", () => {
  test("highlights a fenced code block", async () => {
    const html = await parse("```ts\nconst answer = 42\n```")
    expect(html).toContain("<pre")
    // shiki wraps each token in its own span; an unhighlighted block would not.
    expect(html).toContain("<span")
    expect(html).toContain("answer")
  })

  test("falls back to plain text for a language shiki does not bundle", async () => {
    const html = await parse("```notalanguage\nhello\n```")
    expect(html).toContain("hello")
  })

  test("handles a fence with no language", async () => {
    const html = await parse("```\nbare\n```")
    expect(html).toContain("bare")
  })
})

describe("highlight cache", () => {
  const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```"

  test("re-parsing a growing message keeps the finished block byte-identical", async () => {
    const block = fence("ts", "const a = 1")
    const first = await parse(block + "\n\nprosa")
    const second = await parse(block + "\n\nprosa\n\naltra prosa")
    // Only the tail grows between ticks; the completed block must not change.
    const upToFirstPre = (html: string) => html.slice(0, html.indexOf("</pre>") + 6)
    expect(upToFirstPre(second)).toBe(upToFirstPre(first))
  })

  test("different code in the same language is not served from another entry", async () => {
    const one = await parse(fence("ts", "const alpha = 1"))
    const two = await parse(fence("ts", "const beta = 2"))
    expect(one).not.toBe(two)
    expect(two).toContain("beta")
    expect(two).not.toContain("alpha")
  })

  test("a language and a body cannot be confused for a different split of the same text", async () => {
    // The cache key is language + separator + source, so a separator that can
    // occur inside a language name lets two different pairs build the same key
    // and serve each other's HTML.
    //
    // The fenced path cannot reach this: marked-shiki cuts the info string at the
    // first space, so only one word ever arrives as the language. The host-parser
    // path can — the language is read straight out of `class="language-([^"]*)"`,
    // which carries whatever the host wrote, spaces and all.
    const parseNative = (html: string) => createMarkedParser({ nativeParser: async () => html }).parse("ignored")
    const block = (lang: string, code: string) => `<pre><code class="language-${lang}">${code}</code></pre>`

    // Under a space separator both of these key on "ts const shared = 1".
    const first = await parseNative(block("ts", "const shared = 1"))
    const second = await parseNative(block("ts const shared", "= 1"))

    // Neither is highlighted as the other: the second is not a real language, so
    // it falls back to plain text, and the first keeps its TypeScript colouring.
    expect(first).toContain("const")
    expect(first).not.toBe(second)
    expect(second).not.toContain("const")
  })

  test("the same source under a different language is highlighted separately", async () => {
    const asTs = await parse(fence("ts", "let x = 1"))
    const asPy = await parse(fence("python", "let x = 1"))
    expect(asTs).not.toBe(asPy)
  })
})

describe("native parser path", () => {
  test("runs math and highlighting over HTML the host parser produced", async () => {
    const native = createMarkedParser({
      nativeParser: async (markdown) => `<p>${markdown}</p>`,
    })
    const html = await native.parse("inline $a+b$ math")
    expect(html).toContain("katex")
  })

  test("leaves code and kbd contents out of the math pass", async () => {
    const native = createMarkedParser({
      nativeParser: async () => "<p><code>$notmath$</code> and $x$</p>",
    })
    const html = await native.parse("ignored")
    expect(html).toContain("$notmath$")
    expect(html).toContain("katex")
  })
})
