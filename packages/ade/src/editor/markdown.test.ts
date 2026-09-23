import { describe, expect, test } from "bun:test"
import { folderOf, imageSource, joinPath, linkTarget, renderMarkdown, sanitizerWorks } from "./markdown"

/*
 * happy-dom and DOMPurify 3.4. The known trap is that `sanitize` drops the
 * first node, in happy-dom only; under this preload it does worse and keeps
 * `<script>` and `onerror` untouched. So the tests that need DOMPurify to clean
 * run only where it does (a real browser), each text still starts with a
 * sacrificial paragraph, and the checks are on what must disappear. Under
 * happy-dom the fallback is what gets tested: no cleaning, no HTML.
 */
const SACRIFICE = "sacrificio\n\n"
const noImages = () => undefined

describe.skipIf(!sanitizerWorks())("renderMarkdown with a DOM that cleans (S56)", () => {
  test("drops scripts, handlers, javascript: links and frames", () => {
    const html = renderMarkdown(
      SACRIFICE +
        [
          "# Titolo",
          "<script>document.title='MD'</script>",
          '<img src=x onerror="document.title=\'MD\'">',
          "[clic](javascript:alert(1))",
          '<iframe src="https://example.com"></iframe>',
          '<a href="#" onclick="alert(1)">a</a>',
        ].join("\n\n"),
      noImages,
    )
    expect(html).toContain("Titolo")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("onerror")
    expect(html).not.toContain("onclick")
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("<iframe")
  })

  test("removes an image on the web, so nothing reports the file was opened", () => {
    const html = renderMarkdown(SACRIFICE + "![pixel](https://tracker.example/p.gif)\n\n![inline](data:image/png;base64,AAAA)", () => "ade")
    expect(html).not.toContain("tracker.example")
    expect(html).not.toContain("data:image")
    expect(html).not.toContain("<img")
  })

  test("rewrites a relative image with resolve", () => {
    const seen: string[] = []
    const html = renderMarkdown(SACRIFICE + "![x](img/a.png)", (src) => {
      seen.push(src)
      return "http://ade-media.localhost/C:/p/img/a.png"
    })
    expect(seen).toEqual(["img/a.png"])
    expect(html).toContain('src="http://ade-media.localhost/C:/p/img/a.png"')
  })
})

describe.skipIf(sanitizerWorks())("renderMarkdown where DOMPurify cannot clean (S56)", () => {
  test("gives the text back escaped, never as HTML", () => {
    const html = renderMarkdown(`<script>document.title='MD'</script>\n<img src=x onerror="y">`, noImages)
    expect(html.startsWith("<pre>")).toBe(true)
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<img")
  })
})

describe("imageSource (S56)", () => {
  const resolve = (src: string) => `ade:${src}`

  test("an image on the web or inline never loads", () => {
    for (const src of ["https://tracker.example/p.gif", "http://x/a.png", "//cdn.example/a.png", "data:image/png;base64,AAAA", ""]) {
      expect(imageSource(src, resolve)).toBeUndefined()
    }
  })

  test("a relative image goes through resolve", () => {
    expect(imageSource("img/a.png", resolve)).toBe("ade:img/a.png")
  })
})

describe("links in a markdown preview (S56)", () => {
  test("http(s) goes to ADE's browser, a relative link to a file next to the markdown", () => {
    expect(linkTarget("https://example.com/a", "C:/p/docs")).toEqual({ kind: "web", url: "https://example.com/a" })
    expect(linkTarget("../src/a.ts#L3", "C:/p/docs")).toEqual({ kind: "file", path: "C:/p/src/a.ts" })
    expect(linkTarget("./guida%20due.md", "C:/p/docs")).toEqual({ kind: "file", path: "C:/p/docs/guida due.md" })
  })

  test("an anchor, mailto: or any other scheme does nothing", () => {
    expect(linkTarget("#sezione", "C:/p")).toEqual({ kind: "none" })
    expect(linkTarget("mailto:a@b.c", "C:/p")).toEqual({ kind: "none" })
    expect(linkTarget("javascript:alert(1)", "C:/p")).toEqual({ kind: "none" })
    expect(linkTarget("file:///C:/x", "C:/p")).toEqual({ kind: "none" })
  })

  test("paths", () => {
    expect(folderOf(String.raw`C:\p\docs\a.md`)).toBe(String.raw`C:\p\docs`)
    expect(joinPath("C:/p/docs", "img/a.png")).toBe("C:/p/docs/img/a.png")
    expect(joinPath("C:/p/docs", "../a.png")).toBe("C:/p/a.png")
  })
})
