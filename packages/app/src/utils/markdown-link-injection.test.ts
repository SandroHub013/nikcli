import { describe, expect, test } from "bun:test"
import { createMarkedParser } from "@nikcli-ai/ui/context/marked"
import { sanitize } from "@nikcli-ai/ui/context/markdown-sanitize"

/**
 * The link renderer is overridden to add `target`/`rel`, and an override replaces
 * marked's own escaping. A quote in the href or the title closes the attribute
 * early, and everything after it becomes markup the author did not write.
 *
 * Model output is attacker-reachable: a page the agent fetched, a file it read,
 * a dependency's README. So this is checked at the parser, and again after the
 * sanitiser, because only the pair of them is the real defence.
 */
const { parse } = createMarkedParser()

const ATTACKS = [
  '[x](https://a.test/?q=" onmouseover="alert(1))',
  '[x](https://a.test/" onclick="alert(1))',
  '[x](https://a.test "t\\" onmouseover=\\"alert(1)")',
  '[x](javascript:alert(1))',
  '[x](https://a.test/"><script>alert(1)</script>)',
  // Entity-encoded schemes. These are neutralised by escaping `&` on the way
  // out — the browser decodes `&amp;#x6a;` back to the literal text `&#x6a;`,
  // which is not a scheme — so the escaping is what has to hold, not the
  // decoding done before the check.
  "[x](&#x6a;avascript:alert(1))",
  "[x](&#106;avascript:alert(1))",
  "[x](java&#x09;script:alert(1))",
  "[x](javascript&colon;alert(1))",
  "[x](%6Aavascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](  javascript:alert(1))",
  "[x](data:text/html,<script>alert(1)</script>)",
]

/**
 * Asserted against a parsed document, not against the HTML string.
 *
 * Escaped text reads exactly like an attribute — `&quot; onmouseover=&quot;` has
 * the substring ` onmouseover=` in it — so a string search calls a correct
 * escape a failure and would have sent me chasing a bug that was already fixed.
 * What matters is whether the browser ends up with the attribute.
 */
function attacked(html: string) {
  const host = document.createElement("div")
  host.innerHTML = html
  const handlers: string[] = []
  for (const element of host.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on")) handlers.push(`${element.tagName}.${attribute.name}`)
    }
  }
  return {
    handlers,
    scripts: host.querySelectorAll("script").length,
    hrefs: Array.from(host.querySelectorAll("a")).map((anchor) => anchor.getAttribute("href") ?? ""),
  }
}

describe("link rendering cannot be broken out of", () => {
  test.each(ATTACKS)("%p yields no handler, no script and no executable href", async (markdown) => {
    for (const html of [await parse(markdown), sanitize(await parse(markdown))]) {
      const result = attacked(html)
      expect(result.handlers).toEqual([])
      expect(result.scripts).toBe(0)
      for (const href of result.hrefs) {
        expect(href.toLowerCase().replace(/[\s\u0000-\u001f]/g, "")).not.toStartWith("javascript:")
      }
    }
  })

  test("an ordinary link keeps its href, title and the safety attributes", async () => {
    const host = document.createElement("div")
    host.innerHTML = await parse('[docs](https://example.com/a?b=1&c=2 "The title")')
    const anchor = host.querySelector("a")!
    expect(anchor.getAttribute("href")).toBe("https://example.com/a?b=1&c=2")
    expect(anchor.getAttribute("title")).toBe("The title")
    expect(anchor.getAttribute("target")).toBe("_blank")
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer")
  })

  test("a javascript: link renders as plain text rather than a dead anchor", async () => {
    const host = document.createElement("div")
    host.innerHTML = await parse("[click me](javascript:alert(1))")
    expect(host.querySelector("a")).toBeNull()
    expect(host.textContent).toContain("click me")
  })
})
