import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { addPane, closePane, createWorkbench, focusedInOpenProject, focusInProject, type Pane } from "./state"

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

/*
 * Dario's review of F3, O1: a pane added to a project that is not the open one (a subagent spawned from a
 * session there, a dev browser it owns) took focus, and the next Ctrl+W or «Termina processo» reached it unseen.
 */
describe("adding a pane to a project that is not open", () => {
  const open = (root: string) => ({ ...createWorkbench(), projectPath: root })

  test("a pane of another project does not take the focus", () => {
    let wb = addPane(open(A.root), pane("a1", A.root))
    wb = addPane(wb, pane("b1", B.root))
    expect(wb.panes.map((p) => p.id)).toEqual(["a1", "b1"])
    expect(wb.focusedId).toBe("a1")
  })

  test("with nothing focused it stays that way: the pane is not drawn", () => {
    const wb = addPane(open(A.root), pane("b1", B.root))
    expect(wb.focusedId).toBeUndefined()
  })

  test("a pane of the open project takes the focus, spelled in another case", () => {
    let wb = addPane(open(A.root), pane("a1", A.root))
    wb = addPane(wb, pane("a2", "c:/WORK/a/"))
    expect(wb.focusedId).toBe("a2")
  })

  test("without a project path, or a pane with no folder, the new pane is focused as before", () => {
    expect(addPane(createWorkbench(), pane("b1", B.root)).focusedId).toBe("b1")
    const old = { ...pane("x", A.root), projectRoot: undefined }
    expect(addPane(open(A.root), old).focusedId).toBe("x")
  })
})

describe("close, suspend and kill act only on a pane of the open project", () => {
  let wb = createWorkbench()
  wb = addPane(wb, pane("a1", A.root))
  wb = addPane(wb, pane("b1", B.root))
  // Focus left on b1 (an old id after a switch, or set by some path that missed the guard).
  const onB = { ...wb, focusedId: "b1" }

  test("the focused pane of the open project is the target", () => {
    expect(focusedInOpenProject({ ...wb, focusedId: "a1" }, A)).toBe("a1")
  })

  test("a focused pane of another project is no target", () => {
    expect(focusedInOpenProject(onB, A)).toBeUndefined()
    expect(focusedInOpenProject(onB, B)).toBe("b1")
  })

  test("no focus, a focus on a pane that is gone, or no open project: nothing to guard against", () => {
    expect(focusedInOpenProject({ ...wb, focusedId: undefined }, A)).toBeUndefined()
    expect(focusedInOpenProject({ ...wb, focusedId: "gone" }, A)).toBeUndefined()
    expect(focusedInOpenProject(onB, undefined)).toBe("b1")
  })

  test("the commands use it", () => {
    const source = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")
    const body = (id: string) => source.slice(source.indexOf(`id === "${id}"`)).split("} else if (id ===")[0]!
    for (const id of ["pane.close", "session.suspend", "process.kill"]) {
      expect(body(id)).toContain("focusedHere()")
      expect(body(id)).not.toContain("wb().focusedId")
    }
  })
})
