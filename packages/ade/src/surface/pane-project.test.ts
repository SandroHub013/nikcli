import { describe, expect, test } from "bun:test"
import { paneProject } from "./pane-project"
import { parseWorkspace, serializeWorkspace } from "../session/persist"
import { fromWorkspaceState, toWorkspaceState, type Pane, type Workbench } from "./state"

const mine = { name: "app", root: "C:/lavoro/app" }
const other = { name: "app", root: "D:/clienti/app" }
const recents = [mine, other]

describe("two projects with the same name in different folders", () => {
  test("a pane of the other one is found by its folder, not by the name the open one shares", () => {
    expect(paneProject({ workspaceId: "app", projectRoot: other.root }, mine, recents)).toEqual({ kind: "root", root: other.root })
    expect(paneProject({ workspaceId: "app", projectRoot: mine.root }, other, recents)).toEqual({ kind: "root", root: mine.root })
  })

  test("a pane of the open one is the open one, whatever the slashes", () => {
    expect(paneProject({ workspaceId: "app", projectRoot: "c:\\lavoro\\app\\" }, mine, recents)).toEqual({ kind: "open" })
  })

  test("a pane saved before the folder was kept is still found by name", () => {
    expect(paneProject({ workspaceId: "app" }, mine, recents)).toEqual({ kind: "open" })
    expect(paneProject({ workspaceId: "sito" }, mine, [{ name: "sito", root: "C:/sito" }])).toEqual({ kind: "root", root: "C:/sito" })
    expect(paneProject({ workspaceId: "sparito" }, mine, recents)).toEqual({ kind: "open" })
    expect(paneProject(undefined, mine, recents)).toEqual({ kind: "open" })
  })
})

describe("the folder survives a restart", () => {
  const pane = (overrides: Partial<Pane>): Pane => ({
    id: "p1",
    title: "Claude",
    status: "idle",
    model: "claude",
    agent: "claude-code",
    mode: "auto",
    lines: [],
    workspaceId: "app",
    ...overrides,
  })

  test("saved and read back, a session and a browser pane keep their project's folder", () => {
    const workbench: Workbench = {
      panes: [pane({ projectRoot: other.root }), pane({ id: "b1", title: "Browser", mode: "browser", browserUrl: "http://localhost:3000/", projectRoot: other.root })],
      view: "code",
      sidebarWidth: 260,
    }
    const back = fromWorkspaceState(parseWorkspace(serializeWorkspace(toWorkspaceState(workbench)))!, "app")
    expect(back.panes.map((p) => p.projectRoot)).toEqual([other.root, other.root])
  })

  test("a state saved without folders still restores its panes, found by name", () => {
    const old = serializeWorkspace(toWorkspaceState({ panes: [pane({})], view: "code", sidebarWidth: 260 }))
    const back = fromWorkspaceState(parseWorkspace(old)!, "app")
    expect(back.panes[0]?.projectRoot).toBeUndefined()
    expect(paneProject(back.panes[0], mine, recents)).toEqual({ kind: "open" })
  })
})
