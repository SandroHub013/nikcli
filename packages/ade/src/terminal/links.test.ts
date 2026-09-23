import { describe, expect, test } from "bun:test"
import { findLinks, linksOnRow, logicalLine, type LinkBuffer, type LinkRequest } from "./links"

describe("findLinks (S76)", () => {
  test("drops the full stop after a URL", () => {
    const [link] = findLinks("vedi https://example.com/a.")
    expect(link).toMatchObject({ kind: "url", target: "https://example.com/a" })
  })

  test("keeps a parenthesis the URL opened and drops the one around it", () => {
    const links = findLinks("(https://en.wikipedia.org/wiki/A_(b))")
    expect(links).toHaveLength(1)
    expect(links[0].target).toBe("https://en.wikipedia.org/wiki/A_(b)")
  })

  test("a relative path with a line", () => {
    const [link] = findLinks("src/terminal/registry.ts:222")
    expect(link).toMatchObject({ kind: "file", target: "src/terminal/registry.ts", line: 222 })
    expect(link.end).toBe("src/terminal/registry.ts:222".length)
  })

  test("a Windows path with line and column", () => {
    const [link] = findLinks(String.raw`C:\Users\x\a.ts:10:5`)
    expect(link).toMatchObject({ kind: "file", target: String.raw`C:\Users\x\a.ts`, line: 10, column: 5 })
  })

  test("a compiler's (line,column)", () => {
    const [link] = findLinks("a.rs(12,3)")
    expect(link).toMatchObject({ kind: "file", target: "a.rs", line: 12, column: 3 })
  })

  test("POSIX and ./ paths", () => {
    expect(findLinks("/usr/src/main.c")[0]).toMatchObject({ kind: "file", target: "/usr/src/main.c" })
    expect(findLinks("./a/b.rs")[0]).toMatchObject({ kind: "file", target: "./a/b.rs" })
  })

  test("no other schemes", () => {
    expect(findLinks("javascript:alert(1)")).toEqual([])
    expect(findLinks("file:///C:/x")).toEqual([])
    expect(findLinks("data:text/html,x")).toEqual([])
  })

  test("a bare word with no extension and no line is not a path", () => {
    expect(findLinks("README")).toEqual([])
    expect(findLinks("vedi README.")).toEqual([])
  })

  test("a URL and a path on the same line are two links, and the URL's path is not a file", () => {
    const links = findLinks("echo https://example.com/x.html src/terminal/registry.ts:222")
    expect(links.map((link) => link.kind)).toEqual(["url", "file"])
    expect(links[0].target).toBe("https://example.com/x.html")
  })
})

/** A buffer of rows cut to `cols` cells, the way the pane wraps them. */
function fakeBuffer(rows: Array<{ text: string; wrapped?: boolean }>, type: "normal" | "alternate" = "normal"): LinkBuffer {
  return {
    type,
    getLine: (y) => {
      const row = rows[y]
      if (!row) return undefined
      return {
        isWrapped: Boolean(row.wrapped),
        length: row.text.length,
        getCell: (x) => ({ getChars: () => row.text[x] ?? "", getWidth: () => 1 }),
      }
    },
  }
}

describe("links on a buffer row (S76)", () => {
  const url = "https://example.com/una/pagina/lunga"
  const rows = [{ text: `vai ${url.slice(0, 16)}` }, { text: `${url.slice(16)} ok`, wrapped: true }]

  test("a URL the pane wrapped is one link, from the first row to the second", () => {
    const buffer = fakeBuffer(rows)
    expect(logicalLine(buffer, 1).text).toBe(`vai ${url} ok`)
    for (const row of [1, 2]) {
      const links = linksOnRow(buffer, row, () => {}, () => {})
      expect(links).toHaveLength(1)
      expect(links[0].text).toBe(url)
      expect(links[0].range).toEqual({ start: { x: 5, y: 1 }, end: { x: url.length - 16, y: 2 } })
    }
  })

  test("in the alternate buffer every row stands alone", () => {
    const buffer = fakeBuffer(rows, "alternate")
    expect(logicalLine(buffer, 1).text).toBe(`${url.slice(16)} ok`)
  })

  test("Ctrl+click asks for the system browser, a plain click does not", () => {
    const requests: LinkRequest[] = []
    const [link] = linksOnRow(fakeBuffer([{ text: "https://example.com" }]), 1, (request) => requests.push(request), () => {})
    link.activate({ ctrlKey: true } as MouseEvent, link.text)
    link.activate({ ctrlKey: false } as MouseEvent, link.text)
    expect(requests.map((request) => request.external)).toEqual([true, false])
    expect(requests[0]).toMatchObject({ kind: "url", target: "https://example.com" })
  })

  test("hovering says what a click will do, leaving takes it back", () => {
    const titles: Array<string | undefined> = []
    const [link] = linksOnRow(fakeBuffer([{ text: "src/a.ts:7" }]), 1, () => {}, (title) => titles.push(title))
    link.hover?.({} as MouseEvent, link.text)
    link.leave?.({} as MouseEvent, link.text)
    expect(titles[0]).toContain("7")
    expect(titles[1]).toBeUndefined()
  })
})
