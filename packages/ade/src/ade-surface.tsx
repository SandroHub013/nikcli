/**
 * The ADE surface: sidebar, board and worktrees.
 *
 * Exported so the desktop shell can mount it beside the nikcli interface.
 * `dev.tsx` renders it standalone; nothing here touches the DOM on import.
 *
 * Originally the standalone harness for the ADE shell: sidebar on the left, session grid on the right.
 *
 * Runs with no server and no agent: the panes and files are realistic fixtures.
 * The point is to evaluate the complete shell under real resizing and interactions
 * without standing up a live backend.
 */
import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { BrowserPane } from "./browser"
import { focusAfterClose } from "./grid/focus"
import { type PaneTree, SessionPane, type TranscriptLine } from "./grid/pane"
import { type GridPane, SessionGrid } from "./grid/session-grid"
import { SessionNew } from "./session-new/session-new"
import { agentById } from "./session-new/agents"
import { getHost, type SpawnedSession } from "./host/shell"
import { loadWorktrees } from "./worktrees/provision"
import { provisionSessionTree } from "./worktrees/provision"
import { WorktreeBoard } from "./worktrees/worktree-board"
import type { Occupant, Worktree } from "./worktrees/model"
import {
  type FileNode,
  Sidebar,
  type SidebarSession,
  type Workspace,
} from "./sidebar"
import "./index.css"
import "./dev.css"
import "./browser/browser.css"
import "./session-new/session-new.css"
import "./worktrees/worktree-board.css"

export interface SessionFixture {
  id: string
  workspaceId: string
  title: string
  status: "provisioning" | "working" | "waiting" | "done" | "error"
  activity?: string
  elapsed?: string
  tokens?: string
  model: string
  mode: string
  agent?: string
  lines: TranscriptLine[]
  // When set, the pane renders a live browser instead of a transcript.
  // Same id space as sessions, so close/focus/sidebar rules apply unchanged.
  browserUrl?: string
  /** Directory path where this session process is executing on disk. */
  cwd?: string
  /**
   * Where the session runs and how faithful that checkout is. Carried on the
   * pane rather than left in the transcript: the provisioning note scrolls away,
   * and "which of my six sessions has no isolation" must stay answerable.
   */
  tree?: PaneTree
}

export const SESSION_FIXTURES: SessionFixture[] = [
  {
    id: "s1",
    workspaceId: "ws-ade",
    title: "Estrarre il modello della griglia in un modulo puro",
    status: "working",
    activity: "Ragionando",
    elapsed: "41s",
    tokens: "2,1k token",
    model: "Opus 5",
    mode: "auto",
    agent: "agy",
    lines: [
      { kind: "step", text: "Leggo il layout esistente e i punti che lo consumano" },
      { kind: "shell", text: "$ rg -n 'gridColumns|paneSlot' packages/ade/src" },
      { kind: "step", text: "Due regole degenerano: meno righe, area massima" },
      { kind: "note", text: "Provo il punteggio sulla proporzione in spazio log" },
    ],
  },
  {
    id: "s2",
    workspaceId: "ws-ade",
    title: "Riquadri terminale con layout regolabile",
    status: "waiting",
    activity: "In attesa di permesso",
    elapsed: "12s",
    tokens: "5,8k token",
    model: "Opus 5",
    mode: "chiedi",
    agent: "agy",
    lines: [
      { kind: "step", text: "L'infrastruttura PTY esiste gia: all(), close(id)" },
      { kind: "shell", text: "$ bun test --conditions=browser src/context/terminal" },
      { kind: "step", text: "Manca solo il contenitore a riquadri e la persistenza" },
    ],
  },
  {
    id: "s3",
    workspaceId: "ws-ade",
    title: "Sidebar progetti con sessioni vive annidate",
    status: "done",
    activity: "Fatto",
    elapsed: "3m 08s",
    tokens: "9,4k token",
    model: "Opus 5",
    mode: "auto",
    agent: "agy",
    lines: [
      { kind: "step", text: "ProjectGroup esteso con i figli sessione" },
      { kind: "shell", text: "$ tsc --build packages/ade" },
      { kind: "step", text: "Lo stato per sessione arriva da status().type" },
      { kind: "note", text: "45 test verdi, 0 falliti" },
    ],
  },
  {
    id: "s4",
    workspaceId: "ws-desktop",
    title: "Sonda vocale nella webview reale",
    status: "error",
    activity: "Fallito",
    elapsed: "58s",
    tokens: "3,2k token",
    model: "Opus 5",
    mode: "auto",
    agent: "agy",
    lines: [
      { kind: "step", text: "Verifico se il riconoscimento nativo esiste qui" },
      { kind: "shell", text: "$ bun run dev --  --probe=speech" },
      { kind: "note", text: "SpeechRecognition non definito: serve il percorso audio" },
    ],
  },
  {
    id: "s5",
    workspaceId: "ws-ade",
    title: "Navigazione file stile IDE nel pannello centrale",
    status: "working",
    activity: "Scrivendo",
    elapsed: "22s",
    tokens: "1,3k token",
    model: "Opus 5",
    mode: "auto",
    agent: "agy",
    lines: [
      { kind: "step", text: "L'albero file esiste, manca l'editor al centro" },
      { kind: "shell", text: "$ rg -n 'file://' packages/app/src/pages/session" },
    ],
  },
  {
    id: "s6",
    workspaceId: "ws-desktop",
    title: "Azioni strutturate per il comando vocale",
    status: "waiting",
    activity: "In coda",
    model: "Opus 5",
    mode: "piano",
    agent: "agy",
    lines: [
      { kind: "step", text: "Dipende dai riquadri che espongono azioni comandabili" },
      { kind: "note", text: "Costruirlo prima significa non avere niente da comandare" },
    ],
  },
]

export const FILE_FIXTURES: FileNode[] = [
  {
    id: "pkg",
    name: "packages",
    path: "packages",
    kind: "directory",
    children: [
      {
        id: "pkg-ade",
        name: "ade",
        path: "packages/ade",
        kind: "directory",
        children: [
          {
            id: "pkg-ade-src",
            name: "src",
            path: "packages/ade/src",
            kind: "directory",
            children: [
              {
                id: "pkg-ade-src-grid",
                name: "grid",
                path: "packages/ade/src/grid",
                kind: "directory",
                children: [
                  { id: "f-focus", name: "focus.ts", path: "packages/ade/src/grid/focus.ts", kind: "file" },
                  { id: "f-layout", name: "layout.ts", path: "packages/ade/src/grid/layout.ts", kind: "file" },
                  { id: "f-pane", name: "pane.tsx", path: "packages/ade/src/grid/pane.tsx", kind: "file" },
                  { id: "f-sgrid", name: "session-grid.tsx", path: "packages/ade/src/grid/session-grid.tsx", kind: "file" },
                ],
              },
              {
                id: "pkg-ade-src-sidebar",
                name: "sidebar",
                path: "packages/ade/src/sidebar",
                kind: "directory",
                children: [
                  { id: "f-ftree", name: "file-tree.ts", path: "packages/ade/src/sidebar/file-tree.ts", kind: "file" },
                  { id: "f-sbar", name: "sidebar.tsx", path: "packages/ade/src/sidebar/sidebar.tsx", kind: "file" },
                  { id: "f-stor", name: "storage.ts", path: "packages/ade/src/sidebar/storage.ts", kind: "file" },
                  { id: "f-width", name: "width.ts", path: "packages/ade/src/sidebar/width.ts", kind: "file" },
                  { id: "f-wtree", name: "workspace-tree.ts", path: "packages/ade/src/sidebar/workspace-tree.ts", kind: "file" },
                ],
              },
              { id: "f-dev", name: "dev.tsx", path: "packages/ade/src/dev.tsx", kind: "file" },
              { id: "f-devcss", name: "dev.css", path: "packages/ade/src/dev.css", kind: "file" },
              { id: "f-indexcss", name: "index.css", path: "packages/ade/src/index.css", kind: "file" },
              { id: "f-indexts", name: "index.ts", path: "packages/ade/src/index.ts", kind: "file" },
            ],
          },
          { id: "f-ade-pkg", name: "package.json", path: "packages/ade/package.json", kind: "file" },
          { id: "f-ade-ts", name: "tsconfig.json", path: "packages/ade/tsconfig.json", kind: "file" },
        ],
      },
      {
        id: "pkg-desktop",
        name: "desktop",
        path: "packages/desktop",
        kind: "directory",
        children: [
          {
            id: "pkg-desk-src",
            name: "src",
            path: "packages/desktop/src",
            kind: "directory",
            children: [
              { id: "f-main", name: "main.ts", path: "packages/desktop/src/main.ts", kind: "file" },
              { id: "f-preload", name: "preload.ts", path: "packages/desktop/src/preload.ts", kind: "file" },
            ],
          },
          { id: "f-desk-pkg", name: "package.json", path: "packages/desktop/package.json", kind: "file" },
        ],
      },
      {
        id: "pkg-tui",
        name: "tui",
        path: "packages/tui",
        kind: "directory",
        children: [
          {
            id: "pkg-tui-src",
            name: "src",
            path: "packages/tui/src",
            kind: "directory",
            children: [
              { id: "f-tui-term", name: "terminal.ts", path: "packages/tui/src/terminal.ts", kind: "file" },
            ],
          },
          { id: "f-tui-pkg", name: "package.json", path: "packages/tui/package.json", kind: "file" },
        ],
      },
    ],
  },
  { id: "f-root-pkg", name: "package.json", path: "package.json", kind: "file" },
  { id: "f-root-readme", name: "README.md", path: "README.md", kind: "file" },
  { id: "f-root-turbo", name: "turbo.json", path: "turbo.json", kind: "file" },
]


// Worktree fixtures: the shapes the board has to survive — a contested tree,
// a free one to relocate into, and a stopped occupant that must NOT count as
// holding its tree.
const MINUTE = 60_000

// Where ADE runs today. The harness has one project; a real build reads this
// from the workspace the user opened.
const PROJECT_ID = "nikcli"
const PROJECT_PATH = "C:/Users/39349/Favorites/nikcli"
const BASE_BRANCH = "HEAD"

/**
 * Maps a pane's lifecycle status to a worktree occupant state.
 *
 * Rationale:
 * - A running or provisioning pane actively performs work or sets up disk state -> "working"
 * - A pane waiting for user confirmation / permission -> "waiting"
 * - A finished or failed session has terminated its process and holds no locks -> "stopped"
 */
function paneStatusToOccupantState(status: SessionFixture["status"]): Occupant["state"] {
  if (status === "waiting") return "waiting"
  if (status === "working" || status === "provisioning") return "working"
  return "stopped"
}

/**
 * Normalizes filesystem path separators and removes trailing slashes for consistent map lookups.
 */
function normalizeWorktreePath(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").replace(/\/+$/, "")
}

/**
 * Builds the map of tree paths to active occupants from current session panes.
 *
 * Registers occupants under both raw and normalized paths (and absolute project paths
 * when cwd is relative) so git worktree list porcelain matches regardless of path formatting.
 */
function buildOccupantsByPath(
  paneList: SessionFixture[],
  projectPath: string,
): Map<string, Occupant[]> {
  const map = new Map<string, Occupant[]>()

  const add = (key: string, occupant: Occupant) => {
    const list = map.get(key)
    if (list) {
      if (!list.some((o) => o.sessionId === occupant.sessionId)) {
        list.push(occupant)
      }
    } else {
      map.set(key, [occupant])
    }
  }

  for (const pane of paneList) {
    if (pane.browserUrl) continue
    if (!pane.cwd) continue

    const occupant: Occupant = {
      sessionId: pane.id,
      agentId: pane.agent ?? pane.model ?? "agent",
      state: paneStatusToOccupantState(pane.status),
    }

    const raw = pane.cwd
    const norm = normalizeWorktreePath(raw)
    add(raw, occupant)
    add(norm, occupant)
    add(raw.replace(/\//g, "\\"), occupant)

    // If cwd is relative, also index under the absolute project path
    const isAbs = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")
    if (!isAbs) {
      const full = `${projectPath.replace(/[/\\]+$/, "")}/${raw}`
      add(full, occupant)
      add(normalizeWorktreePath(full), occupant)
      add(full.replace(/\//g, "\\"), occupant)
    }
  }

  return map
}

export function AdeSurface() {
  const [panes, setPanes] = createSignal(SESSION_FIXTURES)
  const [focused, setFocused] = createSignal<string | undefined>("s1")
  const [pinned, setPinned] = createSignal<number | undefined>()
  // Expanding isolates one pane. Pinning to a single column only stacks every pane in a
  // scroller, which leaves the "expanded" one the same height it already was.
  const [expandedId, setExpandedId] = createSignal<string | undefined>()
  const [selectedFile, setSelectedFile] = createSignal<string | undefined>("packages/ade/src/dev.tsx")
  const [view, setView] = createSignal<"plancia" | "alberi">("plancia")
  // The harness has no clock of its own: fixtures carry offsets from this mount.
  const mountedAt = Date.now()

  // The worktree resource reads git via loadWorktrees when a host is available.
  // In the browser harness (no host / getHost() is undefined), it resolves to undefined.
  const [worktrees, { refetch: refetchWorktrees }] = createResource(async () => {
    const host = await getHost()
    if (!host) return undefined

    const occupants = buildOccupantsByPath(panes(), PROJECT_PATH)
    return loadWorktrees({
      host,
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      occupantsByPath: occupants,
      now: Date.now(),
    }).catch(() => [])
  })

  // A browser pane shares the session id space so close/focus rules stay single-sourced,
  // but it is not a session: it must not appear in the session count or the sidebar tree.
  const sessions = createMemo(() => panes().filter((p) => !p.browserUrl))

  const workspaces = createMemo<Workspace[]>(() => {
    const list: Workspace[] = [
      { id: "ws-ade", name: "packages/ade", sessions: [] },
      { id: "ws-desktop", name: "packages/desktop", sessions: [] },
      { id: "ws-tui", name: "packages/tui", sessions: [] },
    ]

    for (const pane of sessions()) {
      const ws = list.find((w) => w.id === pane.workspaceId) ?? list[0]
      const session: SidebarSession = {
        id: pane.id,
        title: pane.title,
        status: pane.status,
        workspaceId: ws.id,
        activity: pane.activity,
      }
      ws.sessions.push(session)
    }

    return list
  })

  // Routes all session closing through the shared focusAfterClose rule
  const close = (id: string, next?: string) => {
    const nextSelection =
      next !== undefined
        ? next
        : focusAfterClose({
            panes: panes().map((p) => p.id),
            focused: focused(),
            closing: id,
          })
    running.get(id)?.kill()
    running.delete(id)
    touchRunning()
    setPanes((current) => current.filter((pane) => pane.id !== id))
    setFocused(nextSelection)
    setExpandedId((current) => (current === id ? undefined : current))
    void refetchWorktrees()
  }

  const add = () => {
    const n = panes().length + 1
    const newId = `s${Date.now()}`
    setPanes((current) => [
      ...current,
      {
        id: newId,
        workspaceId: "ws-ade",
        title: `Nuova sessione agente ${n}`,
        status: "waiting",
        activity: "Inizializzazione",
        model: "Opus 5",
        mode: "auto",
        lines: [{ kind: "note", text: "Sessione avviata nel workspace packages/ade" }],
      },
    ])
    setFocused(newId)
  }

  // The harness has one grid, so "expand" means: this pane alone, full width.
  const expand = (id: string) => {
    setFocused(id)
    setExpandedId((current) => (current === id ? undefined : id))
  }

  // Live processes, one per pane. Kept outside the signal because killing a
  // process is not a render concern, and a pane closing must kill its child.
  const running = new Map<string, SpawnedSession>()
  // A Map is not reactive: without this the prompt would stay disabled after a
  // process starts, and stay enabled after it dies.
  const [runningTick, setRunningTick] = createSignal(0)
  const touchRunning = () => setRunningTick((n) => n + 1)
  // The tick has to be read where the answer is used, or the view never learns
  // that the Map changed underneath it.
  const isRunning = (id: string) => {
    runningTick()
    return running.has(id)
  }

  const appendLine = (id: string, text: string, kind: TranscriptLine["kind"] = "note") =>
    setPanes((all) =>
      all.map((pane) =>
        pane.id === id
          ? // A pane is a window onto a live process, not a log file: keeping the
            // last 200 lines bounds memory without hiding what just happened.
            { ...pane, lines: [...pane.lines, { kind, text }].slice(-200) }
          : pane,
      ),
    )

  const finish = (id: string, code: number | null) => {
    running.delete(id)
    touchRunning()
    setPanes((all) =>
      all.map((pane) =>
        pane.id === id
          ? {
              ...pane,
              status: code === 0 ? ("done" as const) : ("error" as const),
              activity: code === 0 ? "Fatto" : `Uscito con ${code}`,
            }
          : pane,
      ),
    )
    void refetchWorktrees()
  }

  /** Starts the real CLI behind a pane, in its own worktree, or says why not. */
  const startProcess = async (paneId: string, agentId: string, task: string) => {
    const agent = agentById(agentId)
    const host = await getHost()
    if (!agent || !agent.command) return
    if (!host) {
      appendLine(paneId, "Nessun host: in questa build ADE non puo' avviare processi.")
      setPanes((all) => all.map((p) => (p.id === paneId ? { ...p, status: "error", activity: "Non avviato", agent: agentId } : p)))
      return
    }

    // The checkout takes seconds and the transcript is still empty: name the
    // phase before the first git call, not between them — reading the existing
    // trees runs a status per tree and is already long enough to look stuck.
    setPanes((all) =>
      all.map((p) =>
        p.id === paneId ? { ...p, status: "provisioning" as const, activity: "Preparo un albero isolato", agent: agentId } : p,
      ),
    )

    // Isolation first: two agents in one checkout overwrite each other, and by
    // the time that shows up the work is already lost.
    const projectPath = PROJECT_PATH
    const currentOccupants = buildOccupantsByPath(panes(), projectPath)
    const trees = await loadWorktrees({
      host,
      projectId: PROJECT_ID,
      projectPath,
      occupantsByPath: currentOccupants,
      now: Date.now(),
    }).catch(() => [])
    const tree = await provisionSessionTree({
      host,
      projectId: PROJECT_ID,
      projectPath,
      trees,
      sessionId: paneId,
      agentId,
      baseBranch: BASE_BRANCH,
    })
    appendLine(paneId, tree.note)
    const paneTree: PaneTree = { branch: tree.branch, fidelity: tree.fidelity, note: tree.note }

    const args = task && agent.promptArgs ? agent.promptArgs(task) : []
    appendLine(paneId, `${tree.cwd}> ${agent.command} ${args.join(" ")}`.trim(), "shell")
    try {
      const session = await host.spawn({
        command: agent.command,
        args,
        cwd: tree.cwd,
        onLine: (line, stream) => appendLine(paneId, line, stream === "err" ? "note" : "step"),
        onExit: (code) => finish(paneId, code),
      })
      running.set(paneId, session)
      touchRunning()
      setPanes((all) =>
        all.map((p) =>
          p.id === paneId
            ? { ...p, status: "working", activity: "In esecuzione", cwd: tree.cwd, agent: agentId, tree: paneTree }
            : p,
        ),
      )
      void refetchWorktrees()
    } catch (error) {
      appendLine(paneId, error instanceof Error ? error.message : String(error))
      setPanes((all) =>
        all.map((p) =>
          p.id === paneId
            ? { ...p, status: "error", activity: "Avvio fallito", cwd: tree.cwd, agent: agentId, tree: paneTree }
            : p,
        ),
      )
      void refetchWorktrees()
    }
  }

  // Launching from the start screen creates one pane per slot, so the WILL LAUNCH
  // preview and what actually appears in the grid cannot drift apart.
  const addAgent = (
    input: { agentId: string; count: number; task: string; preset?: string },
    slot: number,
  ) => {
    const id = `n${Date.now()}-${slot}`
    setPanes((current) => [
      ...current,
      {
        id,
        workspaceId: "ws-ade",
        title: input.task || `Sessione ${slot + 1} — ${input.agentId}`,
        status: "waiting",
        activity: "Inizializzazione",
        model: input.agentId,
        mode: input.preset ?? "custom",
        lines: [{ kind: "note", text: input.task || "Nessun task iniziale" }],
      },
    ])
    if (slot === 0) setFocused(id)
    void startProcess(id, input.agentId, input.task)
  }

  const addBrowser = () => {
    const newId = `b${Date.now()}`
    setPanes((current) => [
      ...current,
      {
        id: newId,
        workspaceId: "ws-ade",
        title: "Anteprima browser",
        status: "working",
        activity: "Anteprima",
        model: "—",
        mode: "browser",
        lines: [],
        browserUrl: "http://localhost:3000",
      },
    ])
    setFocused(newId)
  }

  // Preserve stable GridPane object identities across renders to avoid destroying DOM nodes
  const paneCache = new Map<string, GridPane>()
  const gridPanes = createMemo<GridPane[]>(() => {
    const all = panes()
    const isolated = expandedId()
    const currentPanes = isolated ? all.filter((p) => p.id === isolated) : all
    const activeIds = new Set(all.map((p) => p.id))
    for (const id of paneCache.keys()) {
      if (!activeIds.has(id)) {
        paneCache.delete(id)
      }
    }

    return currentPanes.map((fixture) => {
      let entry = paneCache.get(fixture.id)
      if (!entry) {
        entry = {
          id: fixture.id,
          render: () => {
            const current = () => panes().find((p) => p.id === fixture.id) ?? fixture
            if (fixture.browserUrl) {
              return (
                <BrowserPane
                  id={fixture.id}
                  title={fixture.title}
                  initialUrl={fixture.browserUrl}
                  focused={fixture.id === focused()}
                  onFocus={() => setFocused(fixture.id)}
                  onClose={() => close(fixture.id)}
                  onExpand={() => expand(fixture.id)}
                  // ponytail: harness has no agent, so the prompt lands in the first
                  // session transcript. Real wiring replaces this with session.prompt().
                  onSendPrompt={(prompt, context) => {
                    const target = panes().find((p) => !p.browserUrl)
                    if (!target) return
                    setPanes((all) =>
                      all.map((p) =>
                        p.id === target.id
                          ? {
                              ...p,
                              lines: [
                                ...p.lines,
                                // The formatted context is a block; a transcript line is one line.
                                ...(context || prompt).split("\n").filter(Boolean).map((text) => ({
                                  kind: "note" as const,
                                  text,
                                })),
                              ],
                            }
                          : p,
                      ),
                    )
                  }}
                />
              )
            }
            return (
              <SessionPane
                title={current().title}
                status={current().status}
                activity={current().activity}
                elapsed={current().elapsed}
                tokens={current().tokens}
                model={current().model}
                mode={current().mode}
                agent={current().agent}
                tree={current().tree}
                onSubmit={
                  isRunning(fixture.id)
                    ? (line) => {
                        // Echo what was sent: without it the answer vanishes and
                        // the transcript reads as if nobody replied.
                        appendLine(fixture.id, `> ${line}`, "shell")
                        running.get(fixture.id)?.write(line)
                      }
                    : undefined
                }
                actions={
                  current().status === "waiting"
                    ? [
                        { label: "Nega", onClick: () => close(fixture.id) },
                        {
                          label: "Concedi",
                          tone: "primary" as const,
                          onClick: () => {
                            setPanes((all) =>
                              all.map((p) =>
                                p.id === fixture.id
                                  ? { ...p, status: "working" as const, activity: "Ragionando" }
                                  : p,
                              ),
                            )
                            void refetchWorktrees()
                          },
                        },
                      ]
                    : current().status === "error"
                      ? [
                          { label: "Log", onClick: () => setFocused(fixture.id) },
                          {
                            label: "Riprova",
                            onClick: () => {
                              setPanes((all) =>
                                all.map((p) =>
                                  p.id === fixture.id
                                    ? { ...p, status: "working" as const, activity: "Riprovo" }
                                    : p,
                                ),
                              )
                              void refetchWorktrees()
                            },
                          },
                        ]
                      : undefined
                }
                lines={current().lines}
                focused={fixture.id === focused()}
                onClose={() => close(fixture.id)}
                onExpand={() => expand(fixture.id)}
              />
            )
          },
        }
        paneCache.set(fixture.id, entry)
      }
      return entry
    })
  })

  return (
    <div data-component="ade-shell">
      <header data-slot="ade-bar">
        <span data-slot="ade-brand">ade</span>
        <span data-slot="ade-divider" aria-hidden="true" />
        <div data-slot="ade-views">
          <button
            type="button"
            data-slot="ade-chip"
            data-active={view() === "plancia" ? "true" : undefined}
            onClick={() => setView("plancia")}
          >
            plancia
          </button>
          <button
            type="button"
            data-slot="ade-chip"
            data-active={view() === "alberi" ? "true" : undefined}
            onClick={() => setView("alberi")}
          >
            alberi
          </button>
        </div>
        <span data-slot="ade-divider" aria-hidden="true" />
        <span data-slot="ade-count">{sessions().length} sessioni</span>
        <Show when={selectedFile()}>
          {(file) => <span data-slot="ade-selected-file">{file()}</span>}
        </Show>
        <div data-slot="ade-spacer" />
        <div data-slot="ade-columns">
          <span data-slot="ade-label">colonne</span>
          <For each={[undefined, 1, 2, 3, 4]}>
            {(value) => (
              <button
                type="button"
                data-slot="ade-chip"
                data-active={pinned() === value ? "true" : undefined}
                onClick={() => {
                  setPinned(value)
                  setExpandedId(undefined)
                }}
              >
                {value === undefined ? "auto" : value}
              </button>
            )}
          </For>
        </div>
        <span data-slot="ade-divider" aria-hidden="true" />
        <button type="button" data-slot="ade-add" onClick={add}>
          + sessione
        </button>
        <button type="button" data-slot="ade-add" onClick={addBrowser}>
          + browser
        </button>
      </header>

      <div data-slot="ade-body">
        <Sidebar
          workspaces={workspaces()}
          selectedSessionId={focused()}
          onSelectSession={setFocused}
          files={FILE_FIXTURES}
          selectedFilePath={selectedFile()}
          onSelectFile={setSelectedFile}
        />

        <main data-slot="ade-main">
          <Show when={view() === "alberi"}>
            <WorktreeBoard
              loading={worktrees.loading}
              emptyReason="Nel browser ADE non puo' leggere git: gli alberi si vedono solo nell'app desktop."
              trees={worktrees()}
                  projectName={(id) => id}
                  now={mountedAt}
                  onRelocate={(input) =>
                    setPanes((all) => [
                      ...all,
                      {
                        id: `r${Date.now()}`,
                        workspaceId: "ws-ade",
                        title: `Spostato ${input.occupant.agentId} fuori da ${input.tree.name}`,
                        status: "waiting",
                        activity: "In attesa",
                        model: input.occupant.agentId,
                        mode: "auto",
                        lines: [{ kind: "note", text: `Albero conteso: ${input.tree.branch}` }],
                      },
                    ])
                  }
                />
          </Show>

          <Show when={view() === "plancia"}>
          {/* With nothing running, the grid is an empty rectangle. The start screen
              is what the user actually needs at that moment, so it takes the space. */}
          <Show
            when={panes().length > 0}
            fallback={
              <SessionNew
                workspace="packages/ade"
                path="~/Favorites/nikcli/packages/ade"
                onLaunch={(input) => {
                  for (let i = 0; i < input.count; i += 1) addAgent(input, i)
                }}
              />
            }
          >
          <SessionGrid
            panes={gridPanes()}
            focused={focused()}
            onFocus={setFocused}
            onClose={close}
            columns={pinned()}
          />
          </Show>
          </Show>
        </main>
      </div>
    </div>
  )
}
