import { focusAfterClose } from "../grid/focus"
import { normalizePath, pathEquals, isAbsolutePath } from "../host/path"
import type { WorkspaceState, PaneState } from "../session/persist"
import type { Occupant } from "../worktrees/model"
import type { TranscriptLine, PaneTree } from "../grid/pane"
import type { Workspace, SidebarSession } from "../sidebar"

export type PaneStatus = "provisioning" | "working" | "waiting" | "done" | "error"

export interface Pane {
  id: string
  title: string
  status: PaneStatus
  activity?: string
  elapsed?: string
  tokens?: string
  model: string
  mode: string
  agent?: string
  lines: TranscriptLine[]
  browserUrl?: string
  cwd?: string
  tree?: PaneTree
  workspaceId: string
  /** Set when the pane holds a file being edited rather than a session. */
  filePath?: string
  /**
   * What this session was asked to do, kept so a retry restarts the same work.
   * Without it "Riprova" relaunches the agent with an empty prompt, which is a
   * different session wearing the same title.
   */
  task?: string
}

export interface Workbench {
  panes: Pane[]
  focusedId?: string
  pinnedColumns?: number
  expandedId?: string
  view: "plancia" | "alberi"
  sidebarWidth: number
  projectPath?: string
}

export function createWorkbench(): Workbench {
  return {
    panes: [],
    view: "plancia",
    sidebarWidth: 260
  }
}

export function paneStatusToOccupantState(status: PaneStatus): Occupant["state"] {
  if (status === "waiting") return "waiting"
  if (status === "working" || status === "provisioning") return "working"
  return "stopped"
}

export function buildOccupantsByPath(panes: Pane[], projectPath: string): Map<string, Occupant[]> {
  const map = new Map<string, Occupant[]>()
  
  const add = (key: string, occupant: Occupant) => {
    const list = map.get(key)
    if (list) {
      if (!list.some(o => o.sessionId === occupant.sessionId)) {
        list.push(occupant)
      }
    } else {
      map.set(key, [occupant])
    }
  }

  for (const pane of panes) {
    if (pane.browserUrl || !pane.cwd) continue

    const occupant: Occupant = {
      sessionId: pane.id,
      agentId: pane.agent ?? pane.model ?? "agent",
      state: paneStatusToOccupantState(pane.status),
    }

    const raw = pane.cwd
    const norm = normalizePath(raw)
    
    add(raw, occupant)
    add(norm, occupant)
    add(raw.replace(/\//g, "\\"), occupant)

    if (!isAbsolutePath(raw)) {
      const full = `${projectPath.replace(/[/\\]+$/, "")}/${raw}`
      add(full, occupant)
      add(normalizePath(full), occupant)
      add(full.replace(/\//g, "\\"), occupant)
    }
  }

  return map
}

export function addPane(workbench: Workbench, pane: Pane): Workbench {
  return {
    ...workbench,
    panes: [...workbench.panes, pane],
    focusedId: pane.id
  }
}

export function closePane(workbench: Workbench, paneId: string): Workbench {
  const nextFocused = focusAfterClose({
    panes: workbench.panes.map((p) => p.id),
    focused: workbench.focusedId,
    closing: paneId,
  })
  
  return {
    ...workbench,
    panes: workbench.panes.filter((p) => p.id !== paneId),
    focusedId: nextFocused,
    expandedId: workbench.expandedId === paneId ? undefined : workbench.expandedId
  }
}

export function updatePane(workbench: Workbench, paneId: string, updates: Partial<Pane>): Workbench {
  return {
    ...workbench,
    panes: workbench.panes.map((p) => (p.id === paneId ? { ...p, ...updates } : p))
  }
}

export function expandPane(workbench: Workbench, paneId: string): Workbench {
  return {
    ...workbench,
    focusedId: paneId,
    expandedId: workbench.expandedId === paneId ? undefined : paneId
  }
}

export function setColumns(workbench: Workbench, columns?: number): Workbench {
  return {
    ...workbench,
    pinnedColumns: columns,
    expandedId: undefined
  }
}

export function deriveWorkspaces(panes: Pane[]): Workspace[] {
  const workspaces: Record<string, Workspace> = {}
  
  for (const pane of panes) {
    if (pane.browserUrl) continue
    
    if (!workspaces[pane.workspaceId]) {
      workspaces[pane.workspaceId] = {
        id: pane.workspaceId,
        name: pane.workspaceId,
        sessions: []
      }
    }
    
    workspaces[pane.workspaceId].sessions.push({
      id: pane.id,
      title: pane.title,
      status: pane.status,
      workspaceId: pane.workspaceId,
      activity: pane.activity
    })
  }
  
  return Object.values(workspaces)
}

export function toWorkspaceState(workbench: Workbench): WorkspaceState {
  return {
    version: 2, // CURRENT_VERSION
    panes: workbench.panes.filter(p => !p.browserUrl).map((p) => ({
      id: p.id,
      title: p.title,
      agent: p.agent ?? p.model ?? "",
      cwd: p.cwd ?? "",
      branch: p.tree?.branch ?? "",
      status: p.status
    })),
    focusedPaneId: workbench.focusedId,
    pinnedColumns: workbench.pinnedColumns,
    currentView: workbench.view,
    sidebarWidth: workbench.sidebarWidth,
    projectPath: workbench.projectPath
  }
}

export function fromWorkspaceState(state: WorkspaceState): Workbench {
  return {
    panes: state.panes.map((p): Pane => ({
      id: p.id,
      title: p.title,
      status: p.status as PaneStatus, // We might need to validate it
      activity: "Ripristinato",
      model: p.agent,
      mode: "auto",
      agent: p.agent,
      cwd: p.cwd,
      lines: [{ kind: "note", text: "Sessione ripristinata dal riavvio. Il processo non è più attivo." }],
      workspaceId: "ws-restored", // placeholder, maybe infer from cwd or keep fixed
      tree: p.branch ? { branch: p.branch, fidelity: "stale", note: "Ripristinato" } : undefined
    })),
    focusedId: state.focusedPaneId,
    pinnedColumns: state.pinnedColumns,
    expandedId: undefined,
    view: (state.currentView as "plancia" | "alberi") || "plancia",
    sidebarWidth: state.sidebarWidth,
    projectPath: state.projectPath
  }
}
