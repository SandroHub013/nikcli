import { describe, expect, test } from "bun:test"
import { ALLOWED_ATTR, ALLOWED_TAGS, folderOf, handlePreviewClick, imageSource, joinPath, linkTarget, renderMarkdown, safeDecodeURI, sanitizerWorks } from "./markdown"

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

describe.skipIf(!sanitizerWorks())("what the preview may contain, with a DOM that cleans (S56, Architect's ALTO)", () => {
  test("form, button, area, audio, video, source and style are removed", () => {
    const html = renderMarkdown(
      SACRIFICE +
        [
          '<form action="https://example.com/form"><button>vai</button><input type="text" name="q"></form>',
          '<map name="m"><area href="https://example.com/area" shape="rect" coords="0,0,9,9"></map>',
          '<audio src="https://example.com/a.mp3"></audio><video><source src="https://example.com/v.mp4"></video>',
          '<p style="background:url(https://example.com/sfondo.png)" id="x">testo</p>',
          "- [x] fatto",
        ].join("\n\n"),
      noImages,
    )
    for (const gone of ["<form", "<button", "<area", "<map", "<audio", "<video", "<source", "style=", "sfondo.png", 'type="text"', "id=", "name="]) {
      expect(html).not.toContain(gone)
    }
    expect(html).toContain("testo")
    expect(html).toContain('type="checkbox"')
  })
})

describe("the preview's allowlist and clicks (S56, Architect's ALTO)", () => {
  test("nothing that submits, navigates by itself, plays or styles is allowed", () => {
    for (const tag of ["form", "button", "area", "map", "audio", "video", "source", "iframe", "object", "embed", "svg", "style", "script"]) {
      expect(ALLOWED_TAGS).not.toContain(tag)
    }
    for (const attribute of ["style", "id", "name", "usemap", "action", "formaction", "srcset"]) {
      expect(ALLOWED_ATTR).not.toContain(attribute)
    }
  })

  test("a click on an area goes through linkTarget and does not navigate", () => {
    const root = document.createElement("div")
    root.innerHTML = '<map><area href="https://example.com/area"></map><span href="../a.md">s</span>'
    document.body.appendChild(root)
    const urls: string[] = []
    const files: string[] = []
    const events: Event[] = []
    root.addEventListener("click", (event) => {
      events.push(event)
      handlePreviewClick(event, "C:/p/docs", { url: (url) => urls.push(url), file: (path) => files.push(path) })
    })
    root.querySelector("area")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    root.querySelector("span")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    root.remove()
    expect(events.map((event) => event.defaultPrevented)).toEqual([true, true])
    expect(urls).toEqual(["https://example.com/area"])
    expect(files).toEqual(["C:/p/a.md"])
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

  test("handles malformed percent sequences like 100%.png without throwing (Punto 9)", () => {
    expect(linkTarget("100%.png", "C:/p/docs")).toEqual({ kind: "file", path: "C:/p/docs/100%.png" })
    expect(linkTarget("folder/100%.png#heading", "C:/p/docs")).toEqual({ kind: "file", path: "C:/p/docs/folder/100%.png" })
  })
})

describe("safeDecodeURI (Punto 9)", () => {
  test("decodes valid percent sequences", () => {
    expect(safeDecodeURI("hello%20world.png")).toBe("hello world.png")
    expect(safeDecodeURI("guida%20due.md")).toBe("guida due.md")
    expect(safeDecodeURI("%C3%A0%C3%A8%C3%AC.txt")).toBe("àèì.txt")
  })

  test("returns raw string without throwing on invalid percent sequences", () => {
    expect(safeDecodeURI("100%.png")).toBe("100%.png")
    expect(safeDecodeURI("%")).toBe("%")
    expect(safeDecodeURI("%E0%A4%A")).toBe("%E0%A4%A")
    expect(safeDecodeURI("file%2.png")).toBe("file%2.png")
  })

  test("renderMarkdown with 100%.png image does not throw and passes through resolver", () => {
    const resolve = (rel: string) => `ade://${safeDecodeURI(rel)}`
    expect(() => renderMarkdown("![graphic](100%.png)", resolve)).not.toThrow()
  })
})

