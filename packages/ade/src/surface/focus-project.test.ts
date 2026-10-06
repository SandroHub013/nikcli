import { describe, expect, test } from "bun:test"
import { addPane, closePane, createWorkbench, focusInProject, type Pane } from "./state"

/*
 * Full review 2026-10-06, sessioni 4: focus left on a pane of another project, one that is not drawn,
 * so Ctrl+W or «Termina processo» acted on it unseen.
 */
const pane = (id: string, root: string): Pane => ({
  id,
  title: id,
  status: "working",
  model: "m",
  mode: "auto",
  lines: [],
  cwd: root,
  workspaceId: root.split("/").pop() ?? root,
  projectRoot: root,
})

const A = { name: "a", root: "C:/work/a" }
const B = { name: "b", root: "C:/work/b" }

describe("closing a pane", () => {
  test("focus goes to a pane of the same project, never to another project's", () => {
    // [a1, b1, a2] with A open: closing the focused a2 must land on a1, not on the hidden b1.
    let wb = createWorkbench()
    for (const [id, root] of [
      ["a1", A.root],
      ["b1", B.root],
      ["a2", A.root],
    ] as const)
      wb = addPane(wb, pane(id, root))
    expect(wb.focusedId).toBe("a2")
    expect(closePane(wb, "a2").focusedId).toBe("a1")
  })

  test("the last pane of a project leaves focus on nothing, not on another project's pane", () => {
    let wb = createWorkbench()
    wb = addPane(wb, pane("b1", B.root))
    wb = addPane(wb, pane("a1", A.root))
    expect(closePane(wb, "a1").focusedId).toBeUndefined()
  })

  test("closing a pane that is not focused keeps focus where it is", () => {
    let wb = createWorkbench()
    for (const [id, root] of [
      ["a1", A.root],
      ["b1", B.root],
      ["a2", A.root],
    ] as const)
      wb = addPane(wb, pane(id, root))
    expect(closePane(wb, "b1").focusedId).toBe("a2")
    expect(closePane(wb, "a1").focusedId).toBe("a2")
  })
})

describe("opening a project", () => {
  const wb = ["a1", "b1", "b2"].reduce(
    (w, id) => addPane(w, pane(id, id.startsWith("a") ? A.root : B.root)),
    createWorkbench(),
  )

  test("focus on a pane of the project left moves to the new project's first pane", () => {
    expect(wb.focusedId).toBe("b2")
    expect(focusInProject(wb, A)).toBe("a1")
  })

  test("focus that already is on the project's pane stays", () => {
    expect(focusInProject(wb, B)).toBe("b2")
  })

  test("a project with no pane has no focus", () => {
    expect(focusInProject(wb, { name: "c", root: "C:/work/c" })).toBeUndefined()
  })
})
