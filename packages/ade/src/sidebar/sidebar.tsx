import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
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
  type SidebarTab,
  deserializeSet,
  parseSidebarTab,
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
  type FlatSessionChildRow,
  type FlatWorkspaceHeaderRow,
  type FlatWorkspaceRow,
  type Workspace,
  flattenWorkspaces,
  toggleWorkspaceExpansion,
} from "./workspace-tree"

export interface SidebarProps {
  workspaces: Workspace[]
  selectedSessionId?: string
  onSelectSession?: (id: string) => void
  files?: FileNode[]
  selectedFilePath?: string
  onSelectFile?: (path: string) => void
  defaultTab?: SidebarTab
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

function SessionChildRow(props: {
  row: FlatSessionChildRow
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
    </button>
  )
}

function WorkspaceTreeRow(props: {
  row: FlatWorkspaceRow
  onToggleWorkspace: (id: string) => void
  onSelectSession?: (id: string) => void
}) {
  if (props.row.type === "workspace") {
    return <WorkspaceHeaderRow row={props.row} onToggle={props.onToggleWorkspace} />
  }
  return <SessionChildRow row={props.row} onSelect={props.onSelectSession} />
}

function FileTreeRow(props: {
  item: FlatFileNode
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
            {/* Files have no chevron; the spacer holds the chevron's 12px box so
                same-depth rows align (chevron svg measures 12x12). */}
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
        {/* A directory without children also has no chevron to show, so it gets
            the same 12px spacer a file gets — depth must read from indent alone. */}
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
        {props.item.name}
      </span>
    </button>
  )
}

/**
 * The ADE sidebar shell component.
 *
 * Provides workspace/session management and an IDE-style file navigator.
 * Sits to the left of the live session grid with persisted resizable width
 * and expansion states.
 */
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

  const initialTab = parseSidebarTab(
    safeGetStorage(storage, STORAGE_KEY_TAB),
    props.defaultTab ?? "sessions",
  )
  const [tab, setTab] = createSignal<SidebarTab>(initialTab)

  // Default all workspaces to expanded so active work is visible on first launch
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

  const switchTab = (nextTab: SidebarTab) => {
    setTab(nextTab)
    safeSetStorage(storage, STORAGE_KEY_TAB, nextTab)
  }

  const toggleWorkspace = (workspaceId: string) => {
    const next = toggleWorkspaceExpansion(expandedWorkspaces(), workspaceId)
    setExpandedWorkspaces(next)
    safeSetStorage(storage, STORAGE_KEY_EXPANDED_WORKSPACES, serializeSet(next))
  }

  const toggleDir = (dirPath: string) => {
    const next = toggleDirectoryExpansion(expandedDirs(), dirPath)
    setExpandedDirs(next)
    safeSetStorage(storage, STORAGE_KEY_EXPANDED_DIRS, serializeSet(next))
  }

  const flatWorkspaces = createMemo(() =>
    flattenWorkspaces(props.workspaces, expandedWorkspaces(), props.selectedSessionId),
  )
  const keyedWorkspaces = createKeyedList(flatWorkspaces, (row) => `${row.type}:${row.id}`)

  const flatFiles = createMemo(() =>
    flattenFileTree(props.files ?? [], expandedDirs(), props.selectedFilePath),
  )
  const keyedFiles = createKeyedList(flatFiles, (item) => item.path)

  let activeResizeCleanup: (() => void) | undefined

  // Detach window event listeners if the component unmounts mid-drag gesture
  onCleanup(() => {
    activeResizeCleanup?.()
  })

  const onResizePointerDown = (event: PointerEvent) => {
    // Prevent text selection during continuous drag gestures
    event.preventDefault()
    // Clean up any stale drag listeners if a previous gesture did not finish
    activeResizeCleanup?.()

    const startX = event.clientX
    const startWidth = width()
    setIsResizing(true)

    const onPointerMove = (e: PointerEvent) => {
      const nextWidth = calculateResize(
        startX,
        e.clientX,
        startWidth,
        props.minWidth ?? MIN_SIDEBAR_WIDTH,
        props.maxWidth ?? MAX_SIDEBAR_WIDTH,
      )
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

  return (
    <aside
      data-component="ade-sidebar"
      data-resizing={isResizing() ? "true" : undefined}
      style={{ width: `${width()}px` }}
    >
      <header data-slot="sidebar-header">
        <nav data-slot="sidebar-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            data-slot="sidebar-tab"
            data-active={tab() === "sessions" ? "true" : undefined}
            aria-selected={tab() === "sessions"}
            onClick={() => switchTab("sessions")}
          >
            Sessioni
          </button>
          <button
            type="button"
            role="tab"
            data-slot="sidebar-tab"
            data-active={tab() === "files" ? "true" : undefined}
            aria-selected={tab() === "files"}
            onClick={() => switchTab("files")}
          >
            File
          </button>
        </nav>
      </header>

      <div data-slot="sidebar-content">
        <Show when={tab() === "sessions"}>
          <div data-component="workspace-tree" role="tree">
            <For each={keyedWorkspaces()}>
              {(entry) => (
                <WorkspaceTreeRow
                  row={entry.data()}
                  onToggleWorkspace={toggleWorkspace}
                  onSelectSession={props.onSelectSession}
                />
              )}
            </For>
          </div>
        </Show>

        <Show when={tab() === "files"}>
          <div data-component="file-tree" role="tree">
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
        </Show>
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
