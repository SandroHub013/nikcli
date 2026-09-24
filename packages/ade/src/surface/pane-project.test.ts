import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { activityLabel } from "../grid/activity"
import { t } from "../i18n"
import { belongsTo, goneFolder, paneProject, sameProject } from "./pane-project"
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

describe("the grid and the pane counts with two projects called app", () => {
  const panes = [
    { id: "a1", workspaceId: "app", projectRoot: mine.root },
    { id: "a2", workspaceId: "app", projectRoot: "c:\\lavoro\\app" },
    { id: "b1", workspaceId: "app", projectRoot: other.root },
    // Saved before panes kept a folder: only the name to go by.
    { id: "old", workspaceId: "app" },
  ]

  test("opened in turn, each shows its own sessions and not the other's", () => {
    expect(panes.filter((pane) => belongsTo(pane, mine)).map((pane) => pane.id)).toEqual(["a1", "a2", "old"])
    expect(panes.filter((pane) => belongsTo(pane, other)).map((pane) => pane.id)).toEqual(["b1", "old"])
  })

  test("a session's neighbours are the panes of its own folder", () => {
    expect(sameProject(panes[0]!, panes[2]!)).toBe(false)
    expect(sameProject(panes[0]!, panes[1]!)).toBe(true)
    expect(sameProject(panes[0]!, panes[3]!)).toBe(true)
  })
})

describe("folders are compared as host/path.ts compares them", () => {
  test("a drive root keeps its slash: C:/ is the root, C: is not the same folder", () => {
    expect(paneProject({ workspaceId: "C:", projectRoot: "C:/" }, { name: "C:", root: "C:" }, [])).toEqual({ kind: "root", root: "C:/" })
    expect(belongsTo({ projectRoot: "d:/" }, { name: "D:", root: "D:/" })).toBe(true)
  })
})

describe("a session whose folder is gone (ROADMAP, BASSO)", () => {
  const gone = (paths: string[]) => async (path: string) => paths.includes(path)
  const open = { name: "nikcli", root: "C:/x/nikcli" }

  test("its project's folder gone: that folder, not the open project to start in", async () => {
    const pane = { workspaceId: "vecchia", projectRoot: "C:/x/nikcli-ade-vecchia" }
    expect(await goneFolder(pane, open, [], gone(["C:/x/nikcli-ade-vecchia"]))).toBe("C:/x/nikcli-ade-vecchia")
  })

  test("its worktree gone: the worktree, which is where it would start", async () => {
    const pane = { workspaceId: "nikcli", projectRoot: open.root, worktree: "C:/x/nikcli-ade-s62" }
    expect(await goneFolder(pane, open, [], gone(["C:/x/nikcli-ade-s62"]))).toBe("C:/x/nikcli-ade-s62")
  })

  test("a pane saved before folders were kept, found by name among the recents", async () => {
    const recents = [{ name: "vecchia", root: "C:/x/nikcli-ade-vecchia" }]
    expect(await goneFolder({ workspaceId: "vecchia" }, open, recents, gone(["C:/x/nikcli-ade-vecchia"]))).toBe("C:/x/nikcli-ade-vecchia")
  })

  test("nothing gone, nothing to say", async () => {
    expect(await goneFolder({ workspaceId: "nikcli", projectRoot: open.root }, open, [], gone([]))).toBeUndefined()
    expect(await goneFolder(undefined, undefined, [], gone(["C:/x"]))).toBeUndefined()
  })
})

test("the pane of a gone folder offers to close, not to restart, and the flag is never saved", () => {
  const source = readFileSync(join(import.meta.dir, "pane-renderer.tsx"), "utf-8")
  expect(source).toContain('current().gone && !deps.isRunning(current().id)')
  expect(source).toMatch(/restartable = \(\) =>\s+!current\(\)\.suspended &&\s+!current\(\)\.gone/)
  expect(t("pane.closeGone")).toBe("Chiudi il pannello")
  expect(activityLabel("folderGone")).toBe("Cartella sparita")
  const pane = { id: "p1", title: "Claude", status: "error", agent: "claude-code", mode: "auto", lines: [], workspaceId: "app", gone: "C:/x/vecchia" } as unknown as Pane
  const state = toWorkspaceState({ panes: [pane], view: "code", sidebarWidth: 260 } as unknown as Workbench)
  expect(JSON.stringify(state)).not.toContain("C:/x/vecchia")
})
