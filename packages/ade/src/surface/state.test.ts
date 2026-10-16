import { describe, test, expect, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseWorkspace, serializeWorkspace } from "../session/persist"
import {
  ADE_VIEWS,
  BOT_ENABLED,
  CHAT_ENABLED,
  VISIBLE_VIEWS,
  visibleViews,
  gatewayControllerOn,
  gatewayVisible,
  isViewVisible,
  nextView,
  reachableView,
  createWorkbench,
  addPane,
  closePane,
  updatePane,
  expandPane,
  setColumns,
  deriveWorkspaces,
  toWorkspaceState,
  fromWorkspaceState,
  type Pane,
} from "./state"

describe("surface state", () => {
  const mockPane: Pane = {
    id: "p1",
    title: "Test",
    status: "working",
    model: "test-model",
    mode: "auto",
    lines: [],
    cwd: "test/path",
    workspaceId: "ws1",
  }

  test("addPane adds pane and focuses it", () => {
    let wb = createWorkbench()
    wb = addPane(wb, mockPane)
    expect(wb.panes).toHaveLength(1)
    expect(wb.panes[0]).toBe(mockPane)
    expect(wb.focusedId).toBe("p1")
  })

  test("closePane removes pane and updates focus", () => {
    let wb = createWorkbench()
    wb = addPane(wb, mockPane)
    wb = addPane(wb, { ...mockPane, id: "p2" })
    expect(wb.panes).toHaveLength(2)
    wb = closePane(wb, "p2")
    expect(wb.panes).toHaveLength(1)
    expect(wb.focusedId).toBe("p1")
  })

  test("updatePane modifies only the target pane", () => {
    let wb = createWorkbench()
    wb = addPane(wb, mockPane)
    wb = updatePane(wb, "p1", { title: "New Title" })
    expect(wb.panes[0].title).toBe("New Title")
  })

  /*
   * `paneStatusToOccupantState` and `buildOccupantsByPath` were tested here
   * and used nowhere else. They existed for the worktree board, which was
   * removed from the interface: the two functions, the `Occupant` model and
   * the whole `worktrees/` subsystem went with it. Their tests were the last
   * thing calling them, which is the shape this clean-up is about.
   */

  test("deriveWorkspaces groups panes", () => {
    const panes: Pane[] = [
      mockPane,
      { ...mockPane, id: "p2", workspaceId: "ws1" },
      { ...mockPane, id: "p3", workspaceId: "ws2" },
      { ...mockPane, id: "b1", browserUrl: "http://url", workspaceId: "ws3" },
    ]
    const ws = deriveWorkspaces(panes)
    expect(ws).toHaveLength(2) // browser is ignored
    expect(ws.find((w) => w.id === "ws1")?.sessions).toHaveLength(2)
    expect(ws.find((w) => w.id === "ws2")?.sessions).toHaveLength(1)
  })

  test("toWorkspaceState and fromWorkspaceState roundtrips basic info", () => {
    let wb = createWorkbench()
    wb = addPane(wb, mockPane)
    const state = toWorkspaceState(wb)
    expect(state.panes).toHaveLength(1)
    expect(state.panes[0].id).toBe("p1")

    const restored = fromWorkspaceState(state)
    expect(restored.panes).toHaveLength(1)
    expect(restored.panes[0].id).toBe("p1")
    /*
     * "done", not "working". The pane was saved mid-run, but a pty is a child
     * of the app: by the time this state is read back the process is gone,
     * whether the user closed the window or the machine restarted. Restoring
     * "working" showed a running session with no pid behind it, with the
     * liveness sweep animating under it. This test used to assert exactly
     * that, and its own comment noted the status was not really restored.
     */
    expect(restored.panes[0].status).toBe("done")
  })
})

describe("panes of several projects, and spawned worktrees, survive a restart", () => {
  test("each pane keeps its project, worktree and spawn arguments", () => {
    let wb = createWorkbench()
    wb = { ...wb, projectPath: "C:/p/web" }
    wb = addPane(wb, {
      id: "a",
      title: "A",
      status: "idle",
      mode: "auto",
      lines: [],
      model: "codex",
      agent: "codex",
      workspaceId: "web",
      cwd: "C:/p/web",
    })
    wb = addPane(wb, {
      id: "b",
      title: "revisore",
      status: "idle",
      mode: "auto",
      lines: [],
      model: "agy",
      agent: "agy",
      workspaceId: "api",
      cwd: "C:/p/api-ade/revisore",
      worktree: "C:/p/api-ade/revisore",
      spawnArgs: ["--model", "gemini-3.1-pro-high"],
      tree: { branch: "ade/revisore", fidelity: "full" },
    })
    const back = fromWorkspaceState(JSON.parse(JSON.stringify(toWorkspaceState(wb))))
    expect(back.panes.map((pane) => pane.workspaceId)).toEqual(["web", "api"])
    expect(back.panes[1]?.worktree).toBe("C:/p/api-ade/revisore")
    expect(back.panes[1]?.spawnArgs).toEqual(["--model", "gemini-3.1-pro-high"])
    expect(back.panes[1]?.tree?.fidelity).toBe("full")
  })
})
describe("the Chat and Bot switches (S40)", () => {
  test("the Bots are back (B7), and the Chat with them (C9)", () => {
    expect(BOT_ENABLED).toBe(true)
    expect(CHAT_ENABLED).toBe(true)
    expect(VISIBLE_VIEWS).toEqual([...ADE_VIEWS])
    expect(reachableView("bot")).toBe("bot")
    expect(reachableView("chat")).toBe("chat")
  })

  test("the visible sections follow each switch, and agent and code are always there", () => {
    expect(visibleViews({ chat: false, bot: false })).toEqual(["agent", "code"])
    expect(visibleViews({ chat: false, bot: true })).toEqual(["agent", "code", "bot"])
    expect(visibleViews({ chat: true, bot: false })).toEqual(["agent", "code", "chat"])
    expect(visibleViews({ chat: true, bot: true })).toEqual([...ADE_VIEWS])
    expect(VISIBLE_VIEWS).toEqual(visibleViews({ chat: CHAT_ENABLED, bot: BOT_ENABLED }))
  })

  for (const chat of [false, true]) {
    for (const bot of [false, true]) {
      test(`a hidden section is never where the cycle or an outside request lands (chat ${chat ? "on" : "off"}, bot ${bot ? "on" : "off"})`, () => {
        const views = visibleViews({ chat, bot })
        const visited = new Set<string>()
        let view = nextView("code", views)
        for (let i = 0; i < ADE_VIEWS.length * 2; i++) {
          expect(isViewVisible(view, views)).toBe(true)
          visited.add(view)
          view = nextView(view, views)
        }
        expect(visited.size).toBe(views.length)
        for (const asked of ADE_VIEWS) expect(isViewVisible(reachableView(asked, views), views)).toBe(true)
        expect(reachableView("chat", views)).toBe(chat ? "chat" : "code")
        expect(reachableView("bot", views)).toBe(bot ? "bot" : "code")
      })
    }
  }
})

describe("the bots' gateway controller (A6)", () => {
  test("listens only on the desktop, with the Bot section on and the Gateway section shown", () => {
    expect(gatewayControllerOn(true, true, true)).toBe(true)
    expect(gatewayControllerOn(false, true, true)).toBe(false)
    expect(gatewayControllerOn(true, false, true)).toBe(false)
    expect(gatewayControllerOn(true, true, false)).toBe(false)
  })

  test("in a release the Gateway section is hidden, so nothing listens", () => {
    expect(gatewayVisible(false, false)).toBe(false)
    expect(gatewayControllerOn(true, true, gatewayVisible(false, false))).toBe(false)
    expect(gatewayControllerOn(true, true, gatewayVisible(false, true))).toBe(true)
  })

  test("the workbench asks it before starting the controller", () => {
    const source = readFileSync(join(__dirname, "workbench.tsx"), "utf-8")
    expect(source).toContain("if (gatewayControllerOn(isTauriDesktop())) {")
    expect(source).not.toMatch(/if \(isTauriDesktop\(\)\) \{\s*let gateway/)
  })
})

describe("a layout saved by a release that had plugin panels", () => {
  /*
   * ADE once saved `framePlugins` next to `browsers` (plugins in a frame, removed 2026-10-06). The release in people's hands may have
   * written one: reading it must drop the field and keep every other panel, without a word in the console.
   */
  const saved = JSON.stringify({
    version: 2,
    panes: [{ id: "s1", title: "Sessione 1", agent: "agy", cwd: "/project", branch: "main", status: "running" }],
    browsers: [{ id: "b1", title: "Docs", url: "https://example.com/" }],
    framePlugins: [{ id: "fp1", plugin: "nikverse", title: "NikVerse", project: "ws", projectRoot: "/project", span: { columns: 2, rows: 1 } }],
    focusedPaneId: "fp1",
    pinnedColumns: 2,
    currentView: "grid",
    sidebarWidth: 280,
    projectPath: "/project",
  })

  test("is restored with the other panels intact and nothing in the console", () => {
    const spies = (["error", "warn"] as const).map((level) => spyOn(console, level).mockImplementation(() => {}))
    try {
      const state = parseWorkspace(saved)
      expect(state).toBeDefined()
      expect(state && "framePlugins" in state).toBe(false)

      const restored = fromWorkspaceState(state!)
      expect(restored.panes.map((pane) => pane.id)).toEqual(["s1", "b1"])
      expect(restored.panes.some((pane) => pane.mode === "plugin-frame")).toBe(false)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  test("focus falls back to a panel that exists when the focused one was a plugin's", () => {
    const restored = fromWorkspaceState(parseWorkspace(saved)!)
    expect(restored.focusedId).toBe("s1")
  })

  test("a focus on a panel that exists is kept", () => {
    const restored = fromWorkspaceState(parseWorkspace(saved.replace('"focusedPaneId":"fp1"', '"focusedPaneId":"b1"'))!)
    expect(restored.focusedId).toBe("b1")
  })
})

describe("a layout saved when the lessons were a panel of their own", () => {
  /** What the file looked like then: a `learns` list, and the focus on that panel. */
  const old = (focused: string | undefined = "l1") => {
    let wb = createWorkbench()
    wb = addPane(wb, { ...mockSession("s1") })
    const saved = JSON.parse(serializeWorkspace(toWorkspaceState(wb)))
    saved.learns = [{ id: "l1", title: "Impara", project: "ws1", span: { columns: 2, rows: 1 } }]
    saved.focusedPaneId = focused
    return JSON.stringify(saved)
  }

  test("starts, with no «Impara» panel, and the focus on a panel that exists", () => {
    const parsed = parseWorkspace(old())
    expect(parsed).toBeDefined()
    const restored = fromWorkspaceState(parsed!)
    expect(restored.panes.map((pane) => pane.id)).toEqual(["s1"])
    expect(restored.panes.some((pane) => (pane.mode as string) === "learn")).toBe(false)
    expect(restored.focusedId).toBe("s1")
  })

  test("the next save has no `learns`, and a layout with several of them starts the same", () => {
    const parsed = parseWorkspace(old())!
    expect((parsed as { learns?: unknown }).learns).toBeUndefined()
    const resaved = JSON.parse(serializeWorkspace(toWorkspaceState(fromWorkspaceState(parsed))))
    expect("learns" in resaved).toBe(false)
    const several = JSON.parse(old())
    several.learns = [...several.learns, { id: "l2", title: "Impara" }, "rotto", null]
    const again = fromWorkspaceState(parseWorkspace(JSON.stringify(several))!)
    expect(again.panes.map((pane) => pane.id)).toEqual(["s1"])
  })

  test("no focus in the file falls to the first panel, and one on a real panel is kept", () => {
    expect(fromWorkspaceState(parseWorkspace(old(undefined))!).focusedId).toBe("s1")
    expect(fromWorkspaceState(parseWorkspace(old("s1"))!).focusedId).toBe("s1")
  })
})

describe("a layout and the RaguVerse panel (the world was called NikVerse, mode \"nikverse\")", () => {
  test("the panel is not saved, so no layout of this build carries its mode", () => {
    let wb = addPane(createWorkbench(), mockSession("s1"))
    wb = addPane(wb, { ...mockSession("w1"), mode: "raguverse" })
    const saved = serializeWorkspace(toWorkspaceState(wb))
    expect(parseWorkspace(saved)!.panes.map((pane) => pane.id)).toEqual(["s1"])
    expect(saved).not.toMatch(/raguverse|nikverse/i)
  })

  test("a layout from before the rename that names a pane in mode \"nikverse\" is read, with the sessions beside it, and the mode is not carried over", () => {
    const old = JSON.stringify({
      version: 2,
      panes: [
        { id: "s1", title: "Sessione 1", agent: "agy", cwd: "/project", branch: "main", status: "running" },
        { id: "nv1", title: "NikVerse", agent: "", cwd: "/project", branch: "", status: "idle", mode: "nikverse" },
      ],
      focusedPaneId: "s1",
      pinnedColumns: 2,
      currentView: "grid",
      sidebarWidth: 280,
      projectPath: "/project",
    })
    const state = parseWorkspace(old)
    expect(state).toBeDefined()
    const restored = fromWorkspaceState(state!)
    expect(restored.panes.some((pane) => pane.id === "s1")).toBe(true)
    expect(restored.panes.some((pane) => pane.mode === "nikverse")).toBe(false)
  })
})

function mockSession(id: string): Pane {
  return { id, title: "Sessione", status: "working", model: "test-model", mode: "auto", lines: [], cwd: "test/path", workspaceId: "ws1" }
}
