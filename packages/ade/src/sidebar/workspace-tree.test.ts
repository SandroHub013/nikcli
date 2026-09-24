import { describe, expect, test } from "bun:test"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import {
  type Workspace,
  countWorkspaceSessions,
  findWorkspaceBySessionId,
  flattenWorkspaces,
  getAllSessionIds,
  isWorkspaceExpanded,
  selectionAfterSessionClose,
  toggleWorkspaceExpansion,
} from "./workspace-tree"

if (typeof document === "undefined") {
  GlobalRegistrator.register()
}
compileSolidJsx()

const { createRoot } = await import("solid-js")
const { createComponent, render } = await import("solid-js/web")
const { Sidebar, WorkspaceTreeRow } = await import("./sidebar")
const { t } = await import("../i18n")

const WORKSPACES_FIXTURE: Workspace[] = [
  {
    id: "ws-ade",
    name: "packages/ade",
    sessions: [
      { id: "s1", title: "Layout della griglia", status: "working" },
      { id: "s2", title: "Riquadri terminale", status: "waiting" },
      { id: "s3", title: "Sidebar progetti", status: "done" },
    ],
  },
  {
    id: "ws-desktop",
    name: "packages/desktop",
    sessions: [
      { id: "s4", title: "Sonda vocale", status: "error" },
      { id: "s5", title: "Navigazione file", status: "working" },
    ],
  },
  {
    id: "ws-empty",
    name: "packages/tui",
    sessions: [],
  },
]

describe("toggleWorkspaceExpansion and isWorkspaceExpanded", () => {
  test("toggles expansion state immutably", () => {
    const initial = new Set(["ws-ade"])

    const expandedDesktop = toggleWorkspaceExpansion(initial, "ws-desktop")
    expect(isWorkspaceExpanded(expandedDesktop, "ws-desktop")).toBe(true)
    expect(isWorkspaceExpanded(expandedDesktop, "ws-ade")).toBe(true)
    expect(isWorkspaceExpanded(initial, "ws-desktop")).toBe(false)

    const collapsedAde = toggleWorkspaceExpansion(expandedDesktop, "ws-ade")
    expect(isWorkspaceExpanded(collapsedAde, "ws-ade")).toBe(false)
    expect(isWorkspaceExpanded(collapsedAde, "ws-desktop")).toBe(true)
  })
})

describe("countWorkspaceSessions", () => {
  test("reports exact session counts per workspace", () => {
    expect(countWorkspaceSessions(WORKSPACES_FIXTURE[0])).toBe(3)
    expect(countWorkspaceSessions(WORKSPACES_FIXTURE[1])).toBe(2)
    expect(countWorkspaceSessions(WORKSPACES_FIXTURE[2])).toBe(0)
  })
})

describe("flattenWorkspaces", () => {
  test("flattens only workspace headers when all are collapsed", () => {
    const rows = flattenWorkspaces(WORKSPACES_FIXTURE, new Set())
    expect(rows.length).toBe(3)
    expect(rows.every((r) => r.type === "workspace")).toBe(true)
    expect(rows[0].id).toBe("ws-ade")
    expect(rows[1].id).toBe("ws-desktop")
    expect(rows[2].id).toBe("ws-empty")
  })

  test("flattens workspace header and session rows when expanded", () => {
    const expanded = new Set(["ws-ade"])
    const rows = flattenWorkspaces(WORKSPACES_FIXTURE, expanded, "s2")

    // ws-ade header + 3 sessions + ws-desktop header + ws-empty header = 6 rows
    expect(rows.length).toBe(6)
    expect(rows[0]).toEqual({
      type: "workspace",
      id: "ws-ade",
      workspace: WORKSPACES_FIXTURE[0],
      isExpanded: true,
      sessionCount: 3,
    })

    expect(rows[1]).toEqual({
      type: "session",
      id: "s1",
      session: WORKSPACES_FIXTURE[0].sessions[0],
      workspaceId: "ws-ade",
      isSelected: false,
    })

    expect(rows[2]).toEqual({
      type: "session",
      id: "s2",
      session: WORKSPACES_FIXTURE[0].sessions[1],
      workspaceId: "ws-ade",
      isSelected: true,
    })

    expect(rows[3]).toEqual({
      type: "session",
      id: "s3",
      session: WORKSPACES_FIXTURE[0].sessions[2],
      workspaceId: "ws-ade",
      isSelected: false,
    })

    expect(rows[4]).toEqual({
      type: "workspace",
      id: "ws-desktop",
      workspace: WORKSPACES_FIXTURE[1],
      isExpanded: false,
      sessionCount: 2,
    })
  })

  test("handles empty workspace list cleanly", () => {
    expect(flattenWorkspaces([], new Set())).toEqual([])
  })
})

describe("findWorkspaceBySessionId and getAllSessionIds", () => {
  test("finds the containing workspace by session id", () => {
    expect(findWorkspaceBySessionId(WORKSPACES_FIXTURE, "s1")?.id).toBe("ws-ade")
    expect(findWorkspaceBySessionId(WORKSPACES_FIXTURE, "s4")?.id).toBe("ws-desktop")
    expect(findWorkspaceBySessionId(WORKSPACES_FIXTURE, "non-existent")).toBeUndefined()
  })

  test("collects all session ids in workspace order", () => {
    expect(getAllSessionIds(WORKSPACES_FIXTURE)).toEqual(["s1", "s2", "s3", "s4", "s5"])
  })
})

describe("selectionAfterSessionClose (Defect 4)", () => {
  test("Defect 4: closing an unselected session preserves the currently selected session", () => {
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s1", "s3")).toBe("s3")
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s4", "s2")).toBe("s2")
  })

  test("Defect 4: closing an unselected session when nothing is selected returns undefined", () => {
    // When nothing is selected, closing a session must not invent a selection
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s1", undefined)).toBeUndefined()
  })

  test("Defect 4: closing an unselected session with a gone id returns undefined", () => {
    // If the selected id is no longer in the session list, it must not invent a selection
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s1", "gone")).toBeUndefined()
  })

  test("Defect 4: closing the selected session moves to its successor in flat display order", () => {
    // Closing s1 (index 0) in ws-ade moves to s2
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s1", "s1")).toBe("s2")
    // Closing s2 (index 1) in ws-ade moves to s3
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s2", "s2")).toBe("s3")
    // Closing s3 (end of ws-ade) advances to successor in next workspace s4 (matches grid focusAfterClose)
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s3", "s3")).toBe("s4")
  })

  test("Defect 4: closing the final session across all workspaces falls back to predecessor", () => {
    // Closing s5 (last session overall) falls back to predecessor s4
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s5", "s5")).toBe("s4")
  })

  test("Defect 4: closing the only session in a workspace advances to the next workspace", () => {
    const fixture: Workspace[] = [
      { id: "w1", name: "w1", sessions: [{ id: "solo-1", title: "Solo 1", status: "done" }] },
      { id: "w2", name: "w2", sessions: [{ id: "next-1", title: "Next 1", status: "working" }] },
    ]

    expect(selectionAfterSessionClose(fixture, "solo-1", "solo-1")).toBe("next-1")
  })

  test("Defect 4: closing the only session in the final workspace falls back to the previous workspace", () => {
    const fixture: Workspace[] = [
      { id: "w1", name: "w1", sessions: [{ id: "prev-1", title: "Prev 1", status: "done" }] },
      { id: "w2", name: "w2", sessions: [{ id: "solo-2", title: "Solo 2", status: "working" }] },
    ]

    expect(selectionAfterSessionClose(fixture, "solo-2", "solo-2")).toBe("prev-1")
  })

  test("Defect 4: closing the sole remaining session across all workspaces returns undefined", () => {
    const fixture: Workspace[] = [
      { id: "w1", name: "w1", sessions: [{ id: "last", title: "Last", status: "done" }] },
    ]

    expect(selectionAfterSessionClose(fixture, "last", "last")).toBeUndefined()
  })

  test("Defect 4: survives closing an untracked id without throwing", () => {
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "unknown", "s1")).toBe("s1")
  })
})

function mountRow(props: {
  row: ReturnType<typeof flattenWorkspaces>[number]
  now?: number
  isActiveSpace?: boolean
  onToggleWorkspace?: (id: string) => void
  onSelectProject?: (id: string) => void
  onSelectSession?: (id: string) => void
}) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = createRoot((dispose) => {
    render(
      () =>
        createComponent(WorkspaceTreeRow, {
          get row() {
            return props.row
          },
          get now() {
            return props.now ?? Date.now()
          },
          get isActiveSpace() {
            return props.isActiveSpace
          },
          onToggleWorkspace: props.onToggleWorkspace ?? (() => {}),
          onSelectProject: props.onSelectProject,
          onSelectSession: props.onSelectSession,
        }),
      host,
    )
    return dispose
  })
  return {
    host,
    cleanup: () => {
      dispose()
      host.remove()
    },
  }
}

describe("WorkspaceTreeRow interactions", () => {
  test("clicking project row calls onToggleWorkspace and does NOT call onSelectProject", () => {
    const toggleCalls: string[] = []
    const selectCalls: string[] = []
    const wsRow = flattenWorkspaces(WORKSPACES_FIXTURE, new Set())[0]

    const { host, cleanup } = mountRow({
      row: wsRow,
      onToggleWorkspace: (id) => toggleCalls.push(id),
      onSelectProject: (id) => selectCalls.push(id),
    })

    const header = host.querySelector('[data-slot="workspace-header"]') as HTMLElement
    expect(header).not.toBeNull()

    header.click()
    expect(toggleCalls).toEqual(["ws-ade"])
    expect(selectCalls).toEqual([])

    // Enter key on header
    header.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(toggleCalls).toEqual(["ws-ade", "ws-ade"])
    expect(selectCalls).toEqual([])

    // Space key on header
    header.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }))
    expect(toggleCalls).toEqual(["ws-ade", "ws-ade", "ws-ade"])
    expect(selectCalls).toEqual([])

    cleanup()
  })

  test("clicking workspace-open-project button calls onSelectProject without toggling", () => {
    const toggleCalls: string[] = []
    const selectCalls: string[] = []
    const wsRow = flattenWorkspaces(WORKSPACES_FIXTURE, new Set())[0]

    const { host, cleanup } = mountRow({
      row: wsRow,
      onToggleWorkspace: (id) => toggleCalls.push(id),
      onSelectProject: (id) => selectCalls.push(id),
    })

    const button = host.querySelector('[data-slot="workspace-open-project"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.getAttribute("title")).toBe(t("sidebar.openProjectSessions"))
    expect(button.getAttribute("aria-label")).toBe(t("sidebar.openProjectSessions"))

    button.click()
    expect(selectCalls).toEqual(["ws-ade"])
    expect(toggleCalls).toEqual([])

    cleanup()
  })

  test("clicking session row in expanded workspace calls onSelectSession", () => {
    const selectSessionCalls: string[] = []
    const expandedRows = flattenWorkspaces(WORKSPACES_FIXTURE, new Set(["ws-ade"]))
    const sessionRow = expandedRows[1]
    expect(sessionRow.type).toBe("session")

    const { host, cleanup } = mountRow({
      row: sessionRow,
      onSelectSession: (id) => selectSessionCalls.push(id),
    })

    const card = host.querySelector('[data-slot="session-row"]') as HTMLElement
    expect(card).not.toBeNull()

    card.click()
    expect(selectSessionCalls).toEqual(["s1"])

    cleanup()
  })

  test("does not render workspace-open-project button when onSelectProject is not provided", () => {
    const wsRow = flattenWorkspaces(WORKSPACES_FIXTURE, new Set())[0]

    const { host, cleanup } = mountRow({
      row: wsRow,
    })

    const button = host.querySelector('[data-slot="workspace-open-project"]')
    expect(button).toBeNull()

    cleanup()
  })

  test("in full Sidebar: clicking project row toggles workspace and does NOT call onSelectProject", () => {
    const selectProjectCalls: string[] = []
    const host = document.createElement("div")
    document.body.append(host)
    const dispose = createRoot((dispose) => {
      render(
        () =>
          createComponent(Sidebar, {
            workspaces: WORKSPACES_FIXTURE,
            onSelectProject: (id) => selectProjectCalls.push(id),
          }),
        host,
      )
      return dispose
    })

    const header = host.querySelector('[data-slot="workspace-header"]') as HTMLElement
    expect(header).not.toBeNull()
    header.click()

    // Clicking header toggles workspace, does NOT call onSelectProject
    expect(selectProjectCalls).toEqual([])

    // Clicking the open-project button calls onSelectProject
    const openBtn = host.querySelector('[data-slot="workspace-open-project"]') as HTMLElement
    expect(openBtn).not.toBeNull()
    openBtn.click()
    expect(selectProjectCalls).toEqual(["ws-ade"])

    dispose()
    host.remove()
  })
})
