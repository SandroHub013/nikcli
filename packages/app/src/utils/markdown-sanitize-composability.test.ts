import { describe, expect, test } from "bun:test"
import { createMarkedParser } from "@nikcli-ai/ui/context/marked"
import { sanitize } from "@nikcli-ai/ui/context/markdown-sanitize"
import { renderIncremental, stableBoundary } from "@nikcli-ai/ui/context/markdown-split"

/**
 * The transcript renders a streaming message segment by segment, joining the
 * HTML of each. That is only sound if sanitising the segments apart gives the
 * same bytes as sanitising the join — otherwise a message would render one way
 * while it streams and another way once it is complete.
 *
 * This lives in `app` rather than `ui` because it needs a real DOM, and `app`
 * is the package that preloads happy-dom.
 */
const { parse } = createMarkedParser()
const render = async (markdown: string) => sanitize(await parse(markdown))

const DOCUMENTS = [
  "First paragraph.\n\nSecond paragraph with **bold** and `code`.\n\nThird.\n",
  "# Title\n\nBody with a [link](https://example.com).\n\n## Section\n\nMore.\n",
  "Before.\n\n```ts\nconst x = 1\n```\n\nAfter the code.\n",
  "Intro.\n\n- one\n- two\n\nOutro.\n",
  "Before.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter.\n",
  "Text with $x + y$ math.\n\nAnd a second paragraph.\n",
  "A paragraph.\n\n> quoted\n\nAnother paragraph.\n",
  // Things a sanitiser is supposed to strip, split across the boundary.
  'Safe text.\n\n<img src=x onerror="alert(1)">\n\nMore safe text.\n',
  "Safe.\n\n<script>alert(1)</script>\n\nAlso safe.\n",
]

// DOMPurify 3.4 under happy-dom drops the first node of every input
// (`x<p>a</p>` comes back as `<p>a</p>`); real Chrome keeps it. Comparing
// renders in a DOM that mangles both sides proves nothing, so the suite waits
// for a DOM that sanitises a plain paragraph intact.
const domIsFaithful = sanitize("<p>a</p>") === "<p>a</p>"

describe.skipIf(!domIsFaithful)("sanitising segments apart matches sanitising the join", () => {
  test.each(DOCUMENTS)("%p", async (document) => {
    for (let length = 0; length <= document.length; length++) {
      const text = document.slice(0, length)
      const boundary = stableBoundary(text)
      if (boundary === 0) continue
      const apart = sanitize(await parse(text.slice(0, boundary))) + sanitize(await parse(text.slice(boundary)))
      expect(`@${length}: ${apart}`).toBe(`@${length}: ${sanitize(await parse(text))}`)
    }
  })

  test.each(DOCUMENTS)("streamed incrementally, every frame equals a full render: %p", async (document) => {
    let prefix
    for (let length = 0; length <= document.length; length++) {
      const result = await renderIncremental({ text: document.slice(0, length), cached: prefix, render })
      prefix = result.prefix
      expect(`@${length}: ${result.html}`).toBe(`@${length}: ${await render(document.slice(0, length))}`)
    }
  })

  test("a payload that survives one sanitize pass does not survive being split", async () => {
    // The concatenation must not let a stripped construct reassemble itself.
    const halves = ['Text.\n\n<div onclick="x()">a</div>\n\n', "<span>b</span>\n"]
    const apart = sanitize(await parse(halves[0]!)) + sanitize(await parse(halves[1]!))
    expect(apart).not.toContain("onclick")
    expect(sanitize(await parse(halves.join("")))).not.toContain("onclick")
  })
})
