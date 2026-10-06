import { describe, expect, test } from "bun:test"
import { createWorkbench, addPane, deriveWorkspaces } from "./state"
import type { Pane } from "./state"

const pane = (id: string, workspaceId: string): Pane => ({
  id,
  title: id,
  status: "working",
  workspaceId,
  model: "claude-code",
  mode: "custom",
  lines: [],
})

describe("deriveWorkspaces", () => {
  test("a project the user opened is listed before it has any session", () => {
    const rows = deriveWorkspaces([], [{ root: "C:/code/alfa", name: "alfa" }])
    expect(rows.map((r) => r.name)).toEqual(["alfa"])
    expect(rows[0]?.sessions).toEqual([])
    expect(rows[0]?.path).toBe("C:/code/alfa")
  })

  test("sessions land under the project they belong to", () => {
    let wb = createWorkbench()
    wb = addPane(wb, pane("p1", "alfa"))
    wb = addPane(wb, pane("p2", "alfa"))
    wb = addPane(wb, pane("p3", "beta"))

    const rows = deriveWorkspaces(wb.panes, [{ root: "C:/code/alfa", name: "alfa" }])
    const alfa = rows.find((r) => r.name === "alfa")
    const beta = rows.find((r) => r.name === "beta")

    expect(alfa?.sessions.map((s) => s.id)).toEqual(["p1", "p2"])
    expect(beta?.sessions.map((s) => s.id)).toEqual(["p3"])
  })

  // Full review 2026-10-06, sessions 10: the final folder is not the project.
  test("two projects whose folders end the same keep two rows, each with its own sessions", () => {
    const known = [
      { root: "C:/a/app", name: "app" },
      { root: "D:/b/app", name: "app" },
    ]
    const rows = deriveWorkspaces(
      [
        { ...pane("p1", "app"), projectRoot: "C:/a/app" },
        { ...pane("p2", "app"), projectRoot: "D:\\b\\APP" },
        { ...pane("p3", "app"), projectRoot: "D:/b/app" },
      ],
      known,
    )
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)
    const first = rows.find((r) => r.path === "C:/a/app")
    const second = rows.find((r) => r.path === "D:/b/app")
    expect(first?.sessions.map((s) => s.id)).toEqual(["p1"])
    expect(second?.sessions.map((s) => s.id)).toEqual(["p2", "p3"])
    expect(first?.name).toBe("app")
  })

  // Review of F6c, N2.
  test("the ids of two projects with the same name are the same whatever the order of the list", () => {
    const one = { root: "C:/a/app", name: "app" }
    const two = { root: "D:/b/app", name: "app" }
    const idsOf = (known: typeof one[]) => Object.fromEntries(deriveWorkspaces([], known).map((r) => [r.path, r.id]))
    expect(idsOf([one, two])).toEqual(idsOf([two, one]))
    expect(idsOf([one, two])).toEqual({ "C:/a/app": "C:/a/app", "D:/b/app": "D:/b/app" })
    // A name that is alone keeps being the id.
    expect(idsOf([one, { root: "C:/c/solo", name: "solo" }])["C:/c/solo"]).toBe("solo")
  })

  test("a pane of an unlisted folder with a name already in use gets its own row", () => {
    const rows = deriveWorkspaces([{ ...pane("p1", "app"), projectRoot: "E:/c/app" }], [{ root: "C:/a/app", name: "app" }])
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.path === "C:/a/app")?.sessions).toEqual([])
    expect(rows.find((r) => r.path === "E:/c/app")?.sessions.map((s) => s.id)).toEqual(["p1"])
  })

  test("a pane without a root still finds its project by name", () => {
    const rows = deriveWorkspaces([pane("p1", "alfa")], [{ root: "C:/code/alfa", name: "alfa" }])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sessions.map((s) => s.id)).toEqual(["p1"])
  })

  test("a known project keeps its row when its last session closes", () => {
    // The regression this guards: derived from panes alone, the project the user
    // is standing in disappears from the list the moment it goes quiet.
    const known = [{ root: "C:/code/alfa", name: "alfa" }]
    const withSession = deriveWorkspaces([pane("p1", "alfa")], known)
    const afterClosing = deriveWorkspaces([], known)

    expect(withSession.map((r) => r.name)).toEqual(["alfa"])
    expect(afterClosing.map((r) => r.name)).toEqual(["alfa"])
  })

  test("a project is listed once even when it is both known and running", () => {
    const rows = deriveWorkspaces([pane("p1", "alfa")], [{ root: "C:/code/alfa", name: "alfa" }])
    expect(rows.length).toBe(1)
    expect(rows[0]?.sessions.length).toBe(1)
  })

  test("browser panes are not sessions and open no project row", () => {
    const rows = deriveWorkspaces([{ ...pane("b1", "alfa"), browserUrl: "http://localhost" }], [])
    expect(rows).toEqual([])
  })
})
