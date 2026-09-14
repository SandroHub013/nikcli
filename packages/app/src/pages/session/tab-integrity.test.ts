import { describe, expect, test } from "bun:test"
import { canActivateFileTab, reconcileActiveTab } from "./tab-integrity"
import { isPseudoTab, parseTab } from "./tab-identity"

/**
 * Both rules guard the same failure: a tab strip pointed at a value that has no
 * trigger and no content, which renders an empty pane the user cannot leave.
 */

describe("isPseudoTab", () => {
  test.each(["review", "context", "browser", "empty"])("%p is owned by its own toggle", (tab) => {
    expect(isPseudoTab(tab)).toBe(true)
  })

  test("a browser tab keeps its identity whatever the url", () => {
    expect(isPseudoTab("browser://localhost:3000/a/b?c=d")).toBe(true)
  })

  test.each([
    "file://src/index.ts",
    "file://packages/app/README.md",
    // Names that begin like a pseudo tab: the check is a scheme, not a prefix.
    "file://browser.ts",
    "file://review/notes.md",
    "file://context",
    // `file.tab()` percent-encodes the path, so the id is not always readable.
    "file://src/a%20b/%C3%A9.ts",
  ])("%p is an ordinary file tab", (tab) => {
    expect(isPseudoTab(tab)).toBe(false)
  })

  test("an id that classifies as neither is not silently treated as a file", () => {
    // A bare path is what the tests used to assert on. It is not what the app
    // produces — `file.tab()` always writes the scheme — so it lands in
    // `unknown`. `isPseudoTab` answers false for both, which is why the old
    // cases stayed green no matter what happened to the file branch.
    expect(parseTab("src/index.ts").kind).toBe("unknown")
    expect(parseTab("file://src/index.ts").kind).toBe("file")
  })
})

describe("reconcileActiveTab", () => {
  test("keeps an active tab that is still open", () => {
    expect(reconcileActiveTab({ active: "file://b.ts", all: ["file://a.ts", "file://b.ts"] })).toBe("file://b.ts")
  })

  test("falls back to the first tab when the active one was closed", () => {
    expect(reconcileActiveTab({ active: "file://gone.ts", all: ["file://a.ts", "file://b.ts"] })).toBe("file://a.ts")
  })

  test("returns nothing when the last tab was closed", () => {
    expect(reconcileActiveTab({ active: "file://gone.ts", all: [] })).toBeUndefined()
  })

  test("never strands a pseudo tab, which is not a list member by design", () => {
    for (const tab of ["review", "context", "browser", "browser://localhost:3000"]) {
      expect(reconcileActiveTab({ active: tab, all: [] })).toBe(tab)
      expect(reconcileActiveTab({ active: tab, all: ["file://a.ts"] })).toBe(tab)
    }
  })

  test("adopts the first tab when nothing was active", () => {
    expect(reconcileActiveTab({ active: undefined, all: ["file://a.ts"] })).toBe("file://a.ts")
    expect(reconcileActiveTab({ active: undefined, all: [] })).toBeUndefined()
  })

  test("the result is always renderable: a pseudo tab, a list member, or nothing", () => {
    const lists = [[], ["file://a.ts"], ["file://a.ts", "file://b.ts"]]
    const actives = [undefined, "file://a.ts", "file://b.ts", "file://gone.ts", "review", "browser://x"]
    for (const all of lists) {
      for (const active of actives) {
        const result = reconcileActiveTab({ active, all })
        if (result === undefined) continue
        expect(isPseudoTab(result) || all.includes(result)).toBe(true)
      }
    }
  })
})

describe("canActivateFileTab", () => {
  test("only a tab that is actually open may be shown as active", () => {
    expect(canActivateFileTab({ candidate: "file://a.ts", all: ["file://a.ts"] })).toBe(true)
    expect(canActivateFileTab({ candidate: "file://a.ts", all: [] })).toBe(false)
    expect(canActivateFileTab({ candidate: "file://a.ts", all: ["file://b.ts"] })).toBe(false)
  })
})
