import { For, Show, createMemo, createSignal, onCleanup, createEffect } from "solid-js"
import "./sidebar.css"
import { getHost } from "../host/shell"
import { discoverProject, type Project } from "../host/project"
import { toDisplayPath } from "../host/path"
import { fuzzyMatch } from "../command/match"
import { formatDuration, elapsed } from "../session/metrics"
import { FilePreview } from "./file-preview"

import {
  type FileNode,
  type FlatFileNode,
  deriveDefaultExpandedDirs,
  expandDirectoryParents,
  flattenFileTree,
  toggleDirectoryExpansion,
} from "./file-tree"
import { createKeyedList } from "./keyed"
import {
  STORAGE_KEY_EXPANDED_DIRS,
  STORAGE_KEY_EXPANDED_WORKSPACES,
  STORAGE_KEY_TAB,
  STORAGE_KEY_WIDTH,
  STORAGE_KEY_SESSIONS_COLLAPSED,
  STORAGE_KEY_SESSIONS_HEIGHT,
  deserializeSet,
  safeGetStorage,
  safeSetStorage,
  serializeSet,
} from "./storage"
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  calculateResize,
  parseSidebarWidth,
} from "./width"
import {
  DEFAULT_SESSIONS_HEIGHT,
  MAX_SESSIONS_HEIGHT,
  MIN_SESSIONS_HEIGHT,
  calculateHeightResize,
  parseSessionsHeight,
} from "./height"
import {
  type FlatSessionChildRow,
  type FlatWorkspaceHeaderRow,
  type FlatWorkspaceRow,
  type Workspace,
  flattenWorkspaces,
  toggleWorkspaceExpansion,
} from "./workspace-tree"
import { mergeChildren, markDirectoryError } from "./fs-tree"

export interface SidebarProps {
  workspaces: Workspace[]
  selectedSessionId?: string
  onSelectSession?: (id: string) => void
  files?: FileNode[]
  selectedFilePath?: string
  onSelectFile?: (path: string) => void
  initialWidth?: number
  minWidth?: number
  maxWidth?: number
  storage?: Storage
}

function WorkspaceHeaderRow(props: {
  row: FlatWorkspaceHeaderRow
  onToggle: (id: string) => void
}) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={1}
      data-slot="workspace-header"
      data-expanded={props.row.isExpanded ? "true" : undefined}
      aria-expanded={props.row.isExpanded}
      onClick={() => props.onToggle(props.row.id)}
    >
      <svg
        data-slot="workspace-chevron"
        viewBox="0 0 12 12"
        width="12"
        height="12"
        aria-hidden="true"
      >
        <path
          d="M4.5 2.5l3.5 3.5-3.5 3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span data-slot="workspace-name" title={props.row.workspace.name}>
        {props.row.workspace.name}
      </span>
      <span data-slot="workspace-count" data-empty={props.row.sessionCount === 0 ? "true" : undefined}>
        {props.row.sessionCount}
      </span>
    </button>
  )
}

function highlightMatch(text: string, ranges?: [number, number][]) {
  if (!ranges || ranges.length === 0) return text
  const res = []
  let last = 0
  for (const [start, end] of ranges) {
    if (start > last) {
      res.push(text.slice(last, start))
    }
    res.push(<span class="highlight-match">{text.slice(start, end)}</span>)
    last = end
  }
  if (last < text.length) {
    res.push(text.slice(last))
  }
  return res
}

function SessionChildRow(props: {
  row: FlatSessionChildRow
  now: number
  onSelect?: (id: string) => void
}) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={2}
      data-slot="session-row"
      data-status={props.row.session.status}
      data-selected={props.row.isSelected ? "true" : undefined}
      aria-selected={props.row.isSelected}
      onClick={() => props.onSelect?.(props.row.id)}
    >
      <span data-slot="session-dot" aria-hidden="true" />
      <span data-slot="session-title" title={props.row.session.title}>
        {props.row.session.title}
      </span>
      <Show when={props.row.session.activity}>
        <span data-slot="session-activity">
          {props.row.session.activity}
          <Show when={props.row.session.startTime}>
            {" • "}{formatDuration(elapsed(props.row.session.startTime!, props.now))}
          </Show>
        </span>
      </Show>
    </button>
  )
}

function WorkspaceTreeRow(props: {
  row: FlatWorkspaceRow
  now: number
  onToggleWorkspace: (id: string) => void
  onSelectSession?: (id: string) => void
}) {
  if (props.row.type === "workspace") {
    return <WorkspaceHeaderRow row={props.row} onToggle={props.onToggleWorkspace} />
  }
  return <SessionChildRow row={props.row} now={props.now} onSelect={props.onSelectSession} />
}

type FlatFileNodeWithRanges = FlatFileNode & { ranges?: [number, number][] }

function FileTreeRow(props: {
  item: FlatFileNodeWithRanges
  onToggleDir: (path: string) => void
  onSelectFile?: (path: string) => void
}) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={props.item.depth + 1}
      data-slot="tree-row"
      data-kind={props.item.kind}
      data-expanded={props.item.isExpanded ? "true" : undefined}
      data-selected={props.item.isSelected ? "true" : undefined}
      aria-selected={props.item.isSelected}
      aria-expanded={props.item.kind === "directory" ? (props.item.hasChildren ? props.item.isExpanded : undefined) : undefined}
      onClick={() => {
        if (props.item.kind === "directory") {
          if (props.item.hasChildren) {
            props.onToggleDir(props.item.path)
          }
        } else {
          props.onSelectFile?.(props.item.path)
        }
      }}
    >
      <Show when={props.item.depth > 0}>
        <div data-slot="tree-indent" aria-hidden="true">
          <For each={Array.from({ length: props.item.depth })}>
            {() => <span data-slot="tree-guide" />}
          </For>
        </div>
      </Show>

      <Show
        when={props.item.kind === "directory"}
        fallback={
          <>
            <span data-slot="tree-spacer" aria-hidden="true" />
            <svg
            data-slot="tree-icon"
            viewBox="0 0 14 14"
            width="14"
            height="14"
            aria-hidden="true"
          >
            <path
              d="M3 1.5h5.5l3 3V12.5C11.5 13.05 11.05 13.5 10.5 13.5H3C2.45 13.5 2 13.05 2 12.5V2.5C2 1.95 2.45 1.5 3 1.5z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.1"
            />
            <path
              d="M8.5 1.5V4.5H11.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.1"
            />
          </svg>
          </>
        }
      >
        <Show
          when={props.item.hasChildren}
          fallback={<span data-slot="tree-spacer" aria-hidden="true" />}
        >
          <svg
            data-slot="tree-chevron"
            viewBox="0 0 12 12"
            width="12"
            height="12"
            aria-hidden="true"
          >
            <path
              d="M4.5 2.5l3.5 3.5-3.5 3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </Show>
        <svg
          data-slot="tree-icon"
          viewBox="0 0 14 14"
          width="14"
          height="14"
          aria-hidden="true"
        >
          <path
            d="M1.5 3.5C1.5 2.67 2.17 2 3 2h2.5c.4 0 .78.16 1.06.44l1 1c.28.28.66.44 1.06.44H11c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5v-7z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.1"
            stroke-linejoin="round"
          />
        </svg>
      </Show>

      <span data-slot="tree-label" title={props.item.name}>
        {highlightMatch(props.item.name, props.item.ranges)}
      </span>
    </button>
  )
}

export function Sidebar(props: SidebarProps) {
  const storage = props.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined)

  const initialWidth = parseSidebarWidth(
    safeGetStorage(storage, STORAGE_KEY_WIDTH),
    props.initialWidth ?? DEFAULT_SIDEBAR_WIDTH,
    props.minWidth ?? MIN_SIDEBAR_WIDTH,
    props.maxWidth ?? MAX_SIDEBAR_WIDTH,
  )
  const [width, setWidth] = createSignal(initialWidth)
  const [isResizing, setIsResizing] = createSignal(false)

  const initialSessionsHeight = parseSessionsHeight(safeGetStorage(storage, STORAGE_KEY_SESSIONS_HEIGHT))
  const [sessionsHeight, setSessionsHeight] = createSignal(initialSessionsHeight)
  const [isResizingSessions, setIsResizingSessions] = createSignal(false)
  const initialSessionsCollapsed = safeGetStorage(storage, STORAGE_KEY_SESSIONS_COLLAPSED) === "true"
  const [sessionsCollapsed, setSessionsCollapsed] = createSignal(initialSessionsCollapsed)

  const initialExpandedWorkspaces = deserializeSet(
    safeGetStorage(storage, STORAGE_KEY_EXPANDED_WORKSPACES),
    props.workspaces.map((w) => w.id),
  )
  const [expandedWorkspaces, setExpandedWorkspaces] = createSignal<Set<string>>(
    initialExpandedWorkspaces,
  )

  const initialExpandedDirs = deserializeSet(
    safeGetStorage(storage, STORAGE_KEY_EXPANDED_DIRS),
    deriveDefaultExpandedDirs(props.files, props.selectedFilePath),
  )
  const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(initialExpandedDirs)

  const [project, setProject] = createSignal<Project | undefined>()
  const [rootNode, setRootNode] = createSignal<FileNode | undefined>()
  const [searchQuery, setSearchQuery] = createSignal("")
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const loadDir = async (dirPath: string) => {
    const host = await getHost()
    if (!host?.readDir) return
    try {
      const entries = await host.readDir(dirPath)
      setRootNode(prev => {
        if (!prev) return prev
        return mergeChildren(prev, dirPath, entries, false)
      })
    } catch {
      setRootNode(prev => {
        if (!prev) return prev
        return markDirectoryError(prev, dirPath)
      })
    }
  }

  const [home, setHome] = createSignal("")

  createEffect(() => {
    getHost().then(host => {
      if (host) {
        host.homeDir?.().then(setHome)
        if (host.currentDir) {
          host.currentDir().then(dir => {
            discoverProject(host, dir).then(p => {
              setProject(p)
              const r: FileNode = {
                id: p.root,
                name: p.name,
                path: p.root,
                kind: "directory"
              }
              setRootNode(r)
              loadDir(p.root)
            })
          })
        }
      }
    })
  })

  const toggleWorkspace = (workspaceId: string) => {
    const next = toggleWorkspaceExpansion(expandedWorkspaces(), workspaceId)
    setExpandedWorkspaces(next)
    safeSetStorage(storage, STORAGE_KEY_EXPANDED_WORKSPACES, serializeSet(next))
  }

  const toggleDir = (dirPath: string) => {
    const next = toggleDirectoryExpansion(expandedDirs(), dirPath)
    setExpandedDirs(next)
    safeSetStorage(storage, STORAGE_KEY_EXPANDED_DIRS, serializeSet(next))
    if (next.has(dirPath)) {
      loadDir(dirPath)
    }
  }

  const toggleSessionsCollapsed = () => {
    const next = !sessionsCollapsed()
    setSessionsCollapsed(next)
    safeSetStorage(storage, STORAGE_KEY_SESSIONS_COLLAPSED, next ? "true" : "false")
  }

  const flatWorkspaces = createMemo(() =>
    flattenWorkspaces(props.workspaces, expandedWorkspaces(), props.selectedSessionId),
  )
  const keyedWorkspaces = createKeyedList(flatWorkspaces, (row) => `${row.type}:${row.id}`)

  const flatFiles = createMemo(() =>
    flattenFileTree(rootNode() ? [rootNode()!] : (props.files ?? []), expandedDirs(), props.selectedFilePath),
  )

  const searchFilteredFiles = createMemo(() => {
    const query = searchQuery()
    const all = flatFiles()
    if (!query) return all

    const matches = new Map<string, [number, number][]>()
    const parentsToKeep = new Set<string>()

    for (const node of all) {
      const match = fuzzyMatch(query, node.name)
      if (match) {
        matches.set(node.path, match.ranges)
        let parentPath = node.parentPath
        while (parentPath) {
          parentsToKeep.add(parentPath)
          const p = all.find(n => n.path === parentPath)
          parentPath = p?.parentPath
        }
      }
    }

    return all.filter(node => matches.has(node.path) || parentsToKeep.has(node.path)).map(node => ({
      ...node,
      ranges: matches.get(node.path)
    }))
  })

  const keyedFiles = createKeyedList(searchFilteredFiles, (item) => item.path)

  let activeResizeCleanup: (() => void) | undefined
  let activeHeightResizeCleanup: (() => void) | undefined

  onCleanup(() => {
    activeResizeCleanup?.()
    activeHeightResizeCleanup?.()
  })

  const onResizePointerDown = (event: PointerEvent) => {
    event.preventDefault()
    activeResizeCleanup?.()

    const startX = event.clientX
    const startWidth = width()
    setIsResizing(true)

    const onPointerMove = (e: PointerEvent) => {
      const nextWidth = calculateResize(startX, e.clientX, startWidth, props.minWidth ?? MIN_SIDEBAR_WIDTH, props.maxWidth ?? MAX_SIDEBAR_WIDTH)
      setWidth(nextWidth)
    }

    const cleanupDrag = () => {
      setIsResizing(false)
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      activeResizeCleanup = undefined
    }

    const onPointerUp = () => {
      cleanupDrag()
      safeSetStorage(storage, STORAGE_KEY_WIDTH, String(width()))
    }

    activeResizeCleanup = cleanupDrag
    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
  }

  const onHeightResizePointerDown = (event: PointerEvent) => {
    event.preventDefault()
    activeHeightResizeCleanup?.()

    const startY = event.clientY
    const startHeight = sessionsHeight()
    setIsResizingSessions(true)

    const onPointerMove = (e: PointerEvent) => {
      const nextHeight = calculateHeightResize(startY, e.clientY, startHeight)
      setSessionsHeight(nextHeight)
    }

    const cleanupDrag = () => {
      setIsResizingSessions(false)
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      activeHeightResizeCleanup = undefined
    }

    const onPointerUp = () => {
      cleanupDrag()
      safeSetStorage(storage, STORAGE_KEY_SESSIONS_HEIGHT, String(sessionsHeight()))
    }

    activeHeightResizeCleanup = cleanupDrag
    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
  }

  const aggregateStats = createMemo(() => {
    let working = 0, waiting = 0, failed = 0
    for (const ws of props.workspaces) {
      for (const s of ws.sessions) {
        if (s.status === "working" || s.status === "provisioning") working++
        else if (s.status === "waiting") waiting++
        else if (s.status === "error") failed++
      }
    }
    return { working, waiting, failed }
  })

  const onSearchInput = (e: Event) => {
    setSearchQuery((e.target as HTMLInputElement).value)
  }

  const onSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setSearchQuery("")
    }
    // basic arrows / enter navigation could be added here
  }

  return (
    <aside
      data-component="ade-sidebar"
      data-resizing={isResizing() ? "true" : undefined}
      style={{ width: `${width()}px` }}
    >
      <header data-slot="sidebar-header-project">
        <Show when={project()}>
          <div data-slot="project-name">
            {project()!.name}
            <Show when={project()!.branch}>
              <span data-slot="project-branch">{project()!.branch}</span>
            </Show>
          </div>
          <span data-slot="project-path" title={project()!.root}>
            {toDisplayPath(project()!.root, home())}
          </span>
        </Show>
      </header>
      
      <div data-slot="sidebar-stats">
        <div data-slot="stat-item">Lavorando: <strong>{aggregateStats().working}</strong></div>
        <div data-slot="stat-item">Attesa: <strong>{aggregateStats().waiting}</strong></div>
        <div data-slot="stat-item">Errori: <strong>{aggregateStats().failed}</strong></div>
      </div>

      <div data-slot="sidebar-sections">
        <div 
          data-slot="sidebar-section-sessions" 
          style={{ height: sessionsCollapsed() ? "auto" : `${sessionsHeight()}px`, "flex-shrink": 0 }}
        >
          <button data-slot="section-header" onClick={toggleSessionsCollapsed}>
            <span>Sessioni</span>
            <svg viewBox="0 0 12 12" width="12" height="12" style={{ transform: sessionsCollapsed() ? "rotate(-90deg)" : "none", transition: "transform 0.15s ease" }}>
              <path d="M2.5 4.5l3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          
          <Show when={!sessionsCollapsed()}>
            <div data-slot="section-content" data-component="workspace-tree" role="tree">
              <For each={keyedWorkspaces()}>
                {(entry) => (
                  <WorkspaceTreeRow
                    row={entry.data()}
                    now={now()}
                    onToggleWorkspace={toggleWorkspace}
                    onSelectSession={props.onSelectSession}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>

        <Show when={!sessionsCollapsed()}>
          <div
            data-slot="sidebar-horizontal-resize-handle"
            onPointerDown={onHeightResizePointerDown}
            role="separator"
            aria-orientation="horizontal"
          />
        </Show>

        <div data-slot="sidebar-section-files">
          <button data-slot="section-header">
            <span>File</span>
          </button>
          
          <div data-slot="search-box">
            <input 
              type="text" 
              data-slot="search-input" 
              placeholder="Cerca fra i file aperti..." 
              value={searchQuery()}
              onInput={onSearchInput}
              onKeyDown={onSearchKeyDown}
            />
          </div>

          <div data-slot="section-content" data-component="file-tree" role="tree">
            <For each={keyedFiles()}>
              {(entry) => (
                <FileTreeRow
                  item={entry.data()}
                  onToggleDir={toggleDir}
                  onSelectFile={props.onSelectFile}
                />
              )}
            </For>
          </div>
        </div>
      </div>

      <div
        data-slot="sidebar-resize-handle"
        onPointerDown={onResizePointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Ridimensiona barra laterale"
      />
    </aside>
  )
}
