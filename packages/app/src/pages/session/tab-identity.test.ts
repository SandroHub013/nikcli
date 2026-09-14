import { describe, expect, test } from "bun:test"
import { isBrowserTab, isFileTab, isPseudoTab, parseTab } from "./tab-identity"

/**
 * These ids were classified by ad-hoc string checks scattered across nine files.
 * The checks disagreed, and the disagreements are what let a tab be active while
 * no pane could render it. The classification is now one function, and it has to
 * be total: no input may fall through unclassified.
 */

const FILE_IDS = ["file://src/index.ts", "file://packages/app/src/pages/session.tsx", "file://a b/c.md"]
const BROWSER_IDS = ["browser", "browser://localhost:3000", "browser://example.com/a?b=c"]

describe("parseTab", () => {
  test.each(FILE_IDS)("%p is a file tab and keeps its path", (id) => {
    const parsed = parseTab(id)
    expect(parsed.kind).toBe("file")
    expect(parsed.kind === "file" && parsed.path).toBe(id.slice("file://".length))
  })

  test("the bare browser tab has no url", () => {
    expect(parseTab("browser")).toEqual({ kind: "browser" })
  })

  test("a browser tab keeps the url it points at", () => {
    expect(parseTab("browser://localhost:3000/a")).toEqual({ kind: "browser", url: "localhost:3000/a" })
  })

  test.each(["review", "context", "empty"])("%p is its own kind", (id) => {
    expect(parseTab(id).kind).toBe(id as ReturnType<typeof parseTab>["kind"])
  })

  test.each(["", "reviewer", "contextual", "emptyish", "file:/x", "browser:/x", "Review", "FILE://x"])(
    "%p is classified as unknown rather than mistaken for a neighbour",
    (id) => {
      expect(parseTab(id).kind).toBe("unknown")
    },
  )

  test("classification is total: every input gets a kind", () => {
    const inputs = [...FILE_IDS, ...BROWSER_IDS, "review", "context", "empty", "", "junk", "file://"]
    for (const id of inputs) expect(typeof parseTab(id).kind).toBe("string")
  })
})

describe("isFileTab / isBrowserTab", () => {
  test.each(FILE_IDS)("%p is a file tab", (id) => {
    expect(isFileTab(id)).toBe(true)
    expect(isBrowserTab(id)).toBe(false)
  })

  test.each(BROWSER_IDS)("%p is a browser tab", (id) => {
    expect(isBrowserTab(id)).toBe(true)
    expect(isFileTab(id)).toBe(false)
  })

  test("a file whose name starts with browser is still a file", () => {
    expect(isFileTab("file://browser.ts")).toBe(true)
    expect(isBrowserTab("file://browser.ts")).toBe(false)
  })
})

describe("isPseudoTab", () => {
  test.each(["review", "context", "empty", ...BROWSER_IDS])("%p is owned by its own toggle", (id) => {
    expect(isPseudoTab(id)).toBe(true)
  })

  test.each(FILE_IDS)("%p is an ordinary list member", (id) => {
    expect(isPseudoTab(id)).toBe(false)
  })

  test("an unknown id is not treated as a pseudo tab, so it can be reconciled away", () => {
    expect(isPseudoTab("junk")).toBe(false)
  })
})
