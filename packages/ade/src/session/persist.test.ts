import { describe, expect, test } from "bun:test"
import { serializeWorkspace, parseWorkspace, migrateWorkspace, CURRENT_VERSION, type WorkspaceState } from "./persist"

const validState: WorkspaceState = {
  version: CURRENT_VERSION,
  panes: [{ id: "p1", title: "Sessione 1", agent: "agy", cwd: "/project", branch: "main", status: "running" }],
  focusedPaneId: "p1",
  pinnedColumns: 2,
  currentView: "grid",
  sidebarWidth: 280,
  projectPath: "/home/user/project",
}

describe("round-trip", () => {
  test("serialize then parse returns equivalent state", () => {
    const json = serializeWorkspace(validState)
    const restored = parseWorkspace(json)
    expect(restored).toBeDefined()
    expect(restored!.version).toBe(CURRENT_VERSION)
    expect(restored!.panes.length).toBe(1)
    expect(restored!.panes[0].id).toBe("p1")
    expect(restored!.focusedPaneId).toBe("p1")
    expect(restored!.pinnedColumns).toBe(2)
    expect(restored!.currentView).toBe("grid")
    expect(restored!.sidebarWidth).toBe(280)
    expect(restored!.projectPath).toBe("/home/user/project")
  })
})

describe("parseWorkspace — tolerance", () => {
  test("invalid JSON returns undefined", () => {
    expect(parseWorkspace("not json")).toBeUndefined()
    expect(parseWorkspace("{truncated")).toBeUndefined()
    expect(parseWorkspace("")).toBeUndefined()
  })

  test("non-object JSON returns undefined", () => {
    expect(parseWorkspace("42")).toBeUndefined()
    expect(parseWorkspace('"hello"')).toBeUndefined()
    expect(parseWorkspace("null")).toBeUndefined()
    expect(parseWorkspace("[1,2,3]")).toBeUndefined()
  })

  test("future version returns undefined", () => {
    const future = JSON.stringify({ version: 999, panes: [] })
    expect(parseWorkspace(future)).toBeUndefined()
  })

  test("missing fields get defaults", () => {
    const minimal = JSON.stringify({ version: CURRENT_VERSION })
    const result = parseWorkspace(minimal)
    expect(result).toBeDefined()
    expect(result!.panes).toEqual([])
    expect(result!.focusedPaneId).toBeUndefined()
    expect(result!.currentView).toBe("grid")
    expect(result!.sidebarWidth).toBe(260)
  })

  test("wrong types get defaults", () => {
    const wrong = JSON.stringify({
      version: CURRENT_VERSION,
      panes: "not an array",
      focusedPaneId: 42,
      currentView: false,
      sidebarWidth: "wide",
    })
    const result = parseWorkspace(wrong)
    expect(result).toBeDefined()
    expect(result!.panes).toEqual([])
    expect(result!.focusedPaneId).toBeUndefined()
    expect(result!.currentView).toBe("grid")
    expect(result!.sidebarWidth).toBe(260)
  })

  test("panes with wrong types get sanitised", () => {
    const bad = JSON.stringify({
      version: CURRENT_VERSION,
      // A pane with a real id and fields of the wrong type is kept and cleaned; one with no usable id is dropped (SES-15).
      panes: [{ id: 42, title: "dropped" }, { id: "p", title: null, agent: undefined }],
    })
    const result = parseWorkspace(bad)
    expect(result).toBeDefined()
    expect(result!.panes).toHaveLength(1)
    expect(result!.panes[0].id).toBe("p")
    expect(result!.panes[0].title).toBe("")
    expect(result!.panes[0].status).toBe("idle")
  })

  test("__proto__ pollution is stripped", () => {
    const hostile = '{"version":' + CURRENT_VERSION + ',"__proto__":{"polluted":true},"panes":[]}'
    const result = parseWorkspace(hostile)
    expect(result).toBeDefined()
    expect((result as any).polluted).toBeUndefined()
  })

  test("constructor key is stripped", () => {
    const hostile = JSON.stringify({
      version: CURRENT_VERSION,
      constructor: { prototype: { evil: true } },
      panes: [],
    })
    const result = parseWorkspace(hostile)
    expect(result).toBeDefined()
  })
})

describe("migrateWorkspace", () => {
  test("migrates v1 to current version", () => {
    const v1 = { version: 1, panes: [], view: "split", focusedPaneId: "x" }
    const migrated = migrateWorkspace(v1)
    expect(migrated).toBeDefined()
    expect(migrated!.version).toBe(CURRENT_VERSION)
    // v1's `view` field is renamed to `currentView`
    expect(migrated!.currentView).toBe("split")
    expect(migrated!.view).toBeUndefined()
    expect(migrated!.sidebarWidth).toBe(260)
  })

  test("already at current version is a no-op", () => {
    const current = { version: CURRENT_VERSION, panes: [], currentView: "grid" }
    const migrated = migrateWorkspace(current)
    expect(migrated).toBeDefined()
    expect(migrated!.version).toBe(CURRENT_VERSION)
  })

  test("unknown version gap returns undefined", () => {
    const unknown = { version: 0, panes: [] }
    const migrated = migrateWorkspace(unknown)
    expect(migrated).toBeUndefined()
  })
})

describe("serializeWorkspace", () => {
  test("always writes the current version", () => {
    const stale = { ...validState, version: 1 }
    const json = serializeWorkspace(stale)
    const parsed = JSON.parse(json)
    expect(parsed.version).toBe(CURRENT_VERSION)
  })

  test("produces valid JSON", () => {
    const json = serializeWorkspace(validState)
    expect(() => JSON.parse(json)).not.toThrow()
  })
})

/*
 * SES-15: a saved workspace with an entry that is not a pane (`{}`, a number), one with no id, or two with the same id
 * was restored with an invented pane for each (the default pane's id), or with two panes that shared an id, which
 * the grid then drew and closed as one. And a `pinnedColumns` of 2.5, 0 or -1 reached the layout as it was.
 */
describe("the panes and the pinned columns of a saved workspace (SES-15)", () => {
  const parse = (panes: unknown, pinnedColumns?: unknown) =>
    parseWorkspace(JSON.stringify({ ...validState, panes, pinnedColumns }))!

  test("only entries with a real id are panes, and the first of an id wins", () => {
    const restored = parse([{ id: "a", title: "x" }, {}, { id: "" }, { id: "a", title: "y" }, 5])
    expect(restored.panes.map((pane) => [pane.id, pane.title])).toEqual([["a", "x"]])
  })

  test("a workspace with no usable pane restores none, not an invented one", () => {
    expect(parse([{}, 5, null, { id: 7 }]).panes).toEqual([])
  })

  test("distinct ids are all kept, in order", () => {
    const restored = parse([{ id: "b" }, { id: "a" }, { id: "c" }])
    expect(restored.panes.map((pane) => pane.id)).toEqual(["b", "a", "c"])
  })

  test("pinnedColumns is a whole number of 1 or more, or nothing", () => {
    expect(parse([], 2.5).pinnedColumns).toBeUndefined()
    expect(parse([], 0).pinnedColumns).toBeUndefined()
    expect(parse([], -1).pinnedColumns).toBeUndefined()
    expect(parse([], 3).pinnedColumns).toBe(3)
    expect(parse([], 1).pinnedColumns).toBe(1)
  })
})
