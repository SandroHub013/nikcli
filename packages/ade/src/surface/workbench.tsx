import { onMount, onCleanup, createSignal, createEffect, createMemo, createResource, Show, For } from "solid-js"
import { getHost, type SpawnedSession } from "../host/shell"
import { discoverProject, openProject, type Project } from "../host/project"
import { addRecent, serializeRecents, parseRecents, type RecentEntry } from "../host/recent"
import { serializeWorkspace, parseWorkspace, type WorkspaceState } from "../session/persist"
import { DEFAULT_BINDINGS, resolveDefaultBindings } from "../keyboard/bindings"
import { formatChord, parseChord, resolveBinding } from "../keyboard/keymap"
import { CommandPalette } from "../command/palette"
import { SessionNew } from "../session-new/session-new"
import { agentById, agentGlyph } from "../session-new/agents"
import { loadWorktrees, provisionSessionTree } from "../worktrees/provision"
import { planIntegration, runIntegration, type IntegrationMode } from "../worktrees/integrate"
import type { Worktree } from "../worktrees/model"
import { WorktreeBoard } from "../worktrees/worktree-board"
import { Sidebar } from "../sidebar"
import { BrowserPane } from "../browser"
import { SessionPane } from "../grid/pane"
import { SessionGrid, type GridPane } from "../grid/session-grid"
import { EmptyProject } from "./empty-project"
import { ProjectBar } from "./project-bar"
import {
  createWorkbench,
  addPane,
  closePane,
  updatePane,
  expandPane,
  setColumns,
  buildOccupantsByPath,
  deriveWorkspaces,
  toWorkspaceState,
  fromWorkspaceState,
  type Workbench as WorkbenchState,
  type Pane
} from "./state"
import { buildCommands, type SurfaceCommand } from "./commands"
import { loadSessionDiff, type SessionDiff } from "../review"
import {
  FilePane,
  editBuffer,
  markSaved,
  openBuffer,
  revertBuffer,
  saveBlockedReason,
  type Buffer,
} from "../editor"
import {
  detectPermission,
  isResolved,
  type PermissionAnswer,
  type PermissionRequest,
} from "../session/permission"
import { readReportLine, type SessionReport } from "../session/report"
import { formatCost, formatTokens } from "../session/metrics"
import { parseTheme, resolveTheme, serializeTheme, type Theme } from "../theme"

const DEFAULT_PREVIEW_URL = "http://localhost:3000"

/** Every command `runCommand` below actually implements. */
const HANDLED_COMMANDS = new Set([
  "palette.open",
  "session.new",
  "project.open",
  "pane.close",
  "pane.expand",
  "view.toggle",
  "theme.toggle",
  "browser.new",
  "worktrees.reload",
  "process.kill",
])

function isHandledCommand(id: string): boolean {
  return HANDLED_COMMANDS.has(id) || id.startsWith("project.recent.")
}

export function Workbench() {
  const platform = navigator.userAgent.includes("Mac") ? "mac" : "other"
  const bindings = resolveDefaultBindings(platform)
  
  const [wb, setWb] = createSignal<WorkbenchState>(createWorkbench())
  const [project, setProject] = createSignal<Project>()
  const [recents, setRecents] = createSignal<RecentEntry[]>([])
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [hasHost, setHasHost] = createSignal(false)
  const [selectedFile, setSelectedFile] = createSignal<string | undefined>()
  // The launch screen is a state, not an empty grid: it has to be reachable with
  // six sessions already running, which is exactly when a seventh is wanted.
  const [starting, setStarting] = createSignal(false)
  // The preference is what gets stored; "system" is a real answer and has to
  // survive a reload, so the resolved value is derived rather than saved.
  const [themePref, setThemePref] = createSignal<Theme>("system")
  const prefersDark = () =>
    typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)").matches : true
  const theme = createMemo(() => resolveTheme(themePref(), prefersDark()))

  /*
   * Review state lives outside the persisted workbench: a diff is a reading of
   * the disk at a moment, and restoring yesterday's one would be showing a
   * picture of a checkout that has moved since.
   */
  /** What each session has told us about its own spending, by pane id. */
  const [reports, setReports] = createSignal<Record<string, SessionReport>>({})

  /** Open file buffers, by pane id. */
  const [buffers, setBuffers] = createSignal<Record<string, Buffer>>({})
  const [bufferLoading, setBufferLoading] = createSignal<Record<string, boolean>>({})

  /** The question each pane is currently stopped on, if any. */
  const [permissions, setPermissions] = createSignal<Record<string, PermissionRequest>>({})
  const [integrationNotice, setIntegrationNotice] = createSignal<string>()
  // How dirty the project is, which decides how loudly the board warns before
  // an integration. Read from git rather than assumed.
  const [projectDirty, setProjectDirty] = createSignal(0)

  const [paneView, setPaneView] = createSignal<Record<string, "transcript" | "diff">>({})
  const [paneDiff, setPaneDiff] = createSignal<Record<string, SessionDiff>>({})
  const [diffLoading, setDiffLoading] = createSignal<Record<string, boolean>>({})

  const running = new Map<string, SpawnedSession>()
  const [runningTick, setRunningTick] = createSignal(0)
  const touchRunning = () => setRunningTick(n => n + 1)
  const isRunning = (id: string) => { runningTick(); return running.has(id) }

  // Load recents and workspace on mount
  onMount(async () => {
    const host = await getHost()
    setHasHost(!!host)
    
    // Load recents
    const savedRecents = localStorage.getItem("ade.recents")
    if (savedRecents) {
      setRecents(parseRecents(savedRecents))
    }

    setThemePref(parseTheme(localStorage.getItem("ade.theme")))
    
    // Load workspace
    const savedWs = localStorage.getItem("ade.workspace")
    if (savedWs) {
      const state = parseWorkspace(savedWs)
      if (state) setWb(fromWorkspaceState(state))
    }
    
    // Discover project
    if (host) {
      const ws = parseWorkspace(savedWs || "")
      const path = ws?.projectPath || (host.currentDir ? await host.currentDir() : "")
      const p = await discoverProject(host, path)
      setProject(p)
      
      const newRecents = addRecent(recents(), { root: p.root, name: p.name })
      setRecents(newRecents)
      localStorage.setItem("ade.recents", serializeRecents(newRecents))
      
      setWb(w => ({ ...w, projectPath: p.root }))
    }
  })

  // Debounced save
  let saveTimeout: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const state = wb()
    clearTimeout(saveTimeout)
    saveTimeout = setTimeout(() => {
      localStorage.setItem("ade.workspace", serializeWorkspace(toWorkspaceState(state)))
    }, 1000)
  })

  const refreshProjectDirty = async () => {
    const host = await getHost()
    const current = project()
    if (!host || !current) return
    const status = await host.run("git", ["status", "--porcelain"], current.root)
    setProjectDirty(status.code === 0 ? status.stdout.split("\n").filter((line) => line.trim()).length : 0)
  }

  createEffect(() => {
    if (project()) void refreshProjectDirty()
  })

  // Worktrees resource
  const [worktrees, { refetch: refetchWorktrees }] = createResource(async () => {
    const host = await getHost()
    const p = project()
    if (!host || !p) return undefined
    
    const occupants = buildOccupantsByPath(wb().panes, p.root)
    return loadWorktrees({
      host,
      projectId: p.name,
      projectPath: p.root,
      occupantsByPath: occupants,
      now: Date.now()
    }).catch(() => [])
  })

  // Keydown listener
  onMount(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
      if (isInput && !e.ctrlKey && !e.metaKey && !e.altKey) return
      
      const id = resolveBinding(bindings, e, platform)
      // Only swallow the key when something will actually happen: a binding
      // that resolves to a command nobody handles would otherwise take the
      // keystroke away from the browser and give nothing back.
      if (id && isHandledCommand(id)) {
        e.preventDefault()
        void runCommand(id)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown))
  })

  // Commands
  const runCommand = async (id: string) => {
    if (id === "palette.open") {
      setPaletteOpen(true)
    } else if (id === "session.new") {
      // A pane is born because a process is starting, never before: the button
      // opens the launch screen and the launch screen creates the panes.
      setStarting(true)
    } else if (id === "project.open") {
      const host = await getHost()
      if (host) {
        const p = await openProject(host)
        if (p) {
          setProject(p)
          setWb(w => ({ ...createWorkbench(), projectPath: p.root })) // clear workspace on new project
          const newRecents = addRecent(recents(), { root: p.root, name: p.name })
          setRecents(newRecents)
          localStorage.setItem("ade.recents", serializeRecents(newRecents))
        }
      }
    } else if (id === "pane.close") {
      if (wb().focusedId) close(wb().focusedId!)
    } else if (id === "pane.expand") {
      if (wb().focusedId) setWb(w => expandPane(w, w.focusedId!))
    } else if (id === "view.toggle") {
      setWb(w => ({ ...w, view: w.view === "plancia" ? "alberi" : "plancia" }))
    } else if (id === "theme.toggle") {
      // The attribute goes on ADE's own root, not the document's: ADE is mounted
      // inside another application and must not restyle its host.
      const next = theme() === "dark" ? "light" : "dark"
      setThemePref(next)
      localStorage.setItem("ade.theme", serializeTheme(next))
    } else if (id === "browser.new") {
      const newId = `b${Date.now()}`
      setWb(w => addPane(w, {
        id: newId,
        title: "Browser",
        status: "working",
        model: "—",
        mode: "browser",
        // Where a dev server usually is. The pane has an address bar, so this is
        // a starting point rather than a decision the user is stuck with.
        browserUrl: DEFAULT_PREVIEW_URL,
        workspaceId: "ws-browser",
        lines: []
      }))
    } else if (id === "worktrees.reload") {
      void refetchWorktrees()
    } else if (id === "process.kill") {
      if (wb().focusedId && isRunning(wb().focusedId!)) {
        running.get(wb().focusedId!)?.kill()
        running.delete(wb().focusedId!)
        touchRunning()
        setWb(w => updatePane(w, w.focusedId!, { status: "error", activity: "Ucciso", lines: [...(w.panes.find(p=>p.id===w.focusedId)?.lines||[]), {kind:"note", text:"Processo ucciso"}] }))
        void refetchWorktrees()
      }
    } else if (id.startsWith("project.recent.")) {
      const root = id.slice("project.recent.".length)
      const host = await getHost()
      if (host) {
        const p = await discoverProject(host, root)
        setProject(p)
        setWb(w => ({ ...createWorkbench(), projectPath: p.root }))
        const newRecents = addRecent(recents(), { root: p.root, name: p.name })
        setRecents(newRecents)
        localStorage.setItem("ade.recents", serializeRecents(newRecents))
      }
    }
    // Moving focus between panes is not handled here: the grid measures its own
    // columns, so `SessionGrid` owns the arrow keys and answers with the real
    // geometry rather than a guess made from the window size.
    setPaletteOpen(false)
  }

  const allCommands = createMemo(() => {
    // Reading the tick is what makes "uccidi processo" enable itself the moment
    // a process starts, and disable itself when it dies.
    runningTick()
    return buildCommands({
      workbench: wb(),
      recents: recents(),
      hasHost: hasHost(),
      running: new Set(running.keys()),
      platform,
    })
  })

  const close = (id: string) => {
    running.get(id)?.kill()
    running.delete(id)
    touchRunning()
    setWb(w => closePane(w, id))
    void refetchWorktrees()
  }

  const finish = (id: string, code: number | null) => {
    running.delete(id)
    touchRunning()
    setWb(w => updatePane(w, id, {
      status: code === 0 ? "done" : "error",
      activity: code === 0 ? "Fatto" : `Uscito con ${code}`
    }))
    void refetchWorktrees()
    // A finished session is exactly when its changes are worth counting, and
    // the count is what makes the review tab worth pressing.
    void refreshDiff(id)
  }

  /**
   * Brings one tree's work back into the project.
   *
   * The plan is built from what git currently says about both sides, run step
   * by step, and whatever comes back — success, refusal, or a conflict git has
   * left half-done — is reported in one sentence rather than swallowed.
   */
  const integrate = async (tree: Worktree, mode: IntegrationMode) => {
    const host = await getHost()
    const current = project()
    if (!host || !current) return

    const dirty = await host.run("git", ["status", "--porcelain"], current.root)
    const projectDirtyNow = dirty.code === 0 ? dirty.stdout.split("\n").filter((l) => l.trim()).length : 0

    const plan = planIntegration({
      branch: tree.branch,
      onto: current.branch ?? "HEAD",
      mode,
      treeDirty: tree.dirty,
      projectDirty: projectDirtyNow,
      ahead: tree.ahead,
    })

    setIntegrationNotice(`Integro ${tree.branch}…`)
    const result = await runIntegration({ host, projectPath: current.root, treePath: tree.path, plan })

    if (result.ok) {
      setIntegrationNotice(`${tree.branch} integrato in ${plan.onto}.`)
    } else if (result.conflict) {
      setIntegrationNotice(
        `${tree.branch}: ${result.conflicts.length} file in conflitto (${result.conflicts.slice(0, 3).join(", ")}). Git ha lasciato il lavoro a metà: risolvi e concludi.`,
      )
    } else {
      setIntegrationNotice(`${tree.branch} non integrato: ${result.reason}`)
    }

    void refetchWorktrees()
    void refreshProjectDirty()
  }

  /*
   * Opening a file makes a pane, like everything else here. A file already
   * open is focused rather than opened twice: two panes over one path would
   * let the user edit the same file against itself.
   */
  const openFile = async (path: string) => {
    setSelectedFile(path)

    const existing = wb().panes.find((pane) => pane.filePath === path)
    if (existing) {
      setWb((w) => ({ ...w, focusedId: existing.id }))
      return
    }

    const host = await getHost()
    if (!host?.readTextFile) return

    const id = `f${Date.now()}`
    setWb((w) =>
      addPane(w, {
        id,
        title: path.split(/[\\/]/).pop() ?? path,
        status: "done",
        model: "—",
        mode: "file",
        filePath: path,
        lines: [],
        workspaceId: project()?.name ?? "workspace",
      }),
    )

    setBufferLoading((current) => ({ ...current, [id]: true }))
    try {
      const read = await host.readTextFile(path)
      setBuffers((current) => ({
        ...current,
        [id]: openBuffer({ path, text: read.text, truncated: read.truncated }),
      }))
    } catch (error) {
      appendLine(id, error instanceof Error ? error.message : String(error))
    } finally {
      setBufferLoading((current) => ({ ...current, [id]: false }))
    }
  }

  const saveFile = async (paneId: string) => {
    const buffer = buffers()[paneId]
    const host = await getHost()
    if (!buffer || !host?.writeTextFile) return
    if (saveBlockedReason(buffer)) return

    const error = await host.writeTextFile(buffer.path, buffer.draft)
    if (error) {
      setIntegrationNotice(`Salvataggio fallito: ${error}`)
      return
    }
    setBuffers((current) => ({ ...current, [paneId]: markSaved(buffer, buffer.draft) }))
  }

  /** Reads what the session actually changed, from git, in its own checkout. */
  const refreshDiff = async (paneId: string) => {
    const pane = wb().panes.find((p) => p.id === paneId)
    const host = await getHost()
    if (!pane?.cwd || !host) return

    setDiffLoading((current) => ({ ...current, [paneId]: true }))
    try {
      const diff = await loadSessionDiff({
        host,
        cwd: pane.cwd,
        // Without a recorded base the session is running in the project itself,
        // where HEAD is the only honest thing to compare against.
        baseRef: pane.tree?.base ?? "HEAD",
      })
      setPaneDiff((current) => ({ ...current, [paneId]: diff }))
    } finally {
      setDiffLoading((current) => ({ ...current, [paneId]: false }))
    }
  }

  const showPaneView = (paneId: string, view: "transcript" | "diff") => {
    setPaneView((current) => ({ ...current, [paneId]: view }))
    // Always re-read on entry: the agent has usually written something since
    // the last look, and a stale diff is the one thing a review must not be.
    if (view === "diff") void refreshDiff(paneId)
  }

  const appendLine = (id: string, text: string, kind: "step" | "shell" | "note" = "note") => {
    setWb(w => {
      const pane = w.panes.find(p => p.id === id)
      if (!pane) return w
      return updatePane(w, id, { lines: [...pane.lines, { kind, text }].slice(-200) })
    })
    watchForPermission(id, text)

    // Agents print what they are spending in among everything else. Reading it
    // here is the only way the pane's counters are real rather than decorative.
    setReports((current) => {
      const before = current[id] ?? {}
      const after = readReportLine(before, text)
      return after === before ? current : { ...current, [id]: after }
    })
  }

  /*
   * An agent that stops to ask something looks, from the outside, exactly like
   * one that is thinking: the process is alive and the output has stopped. The
   * difference is in the last few lines, which is why every line is read for a
   * question before it scrolls away.
   */
  const watchForPermission = (paneId: string, text: string) => {
    const pane = wb().panes.find((p) => p.id === paneId)
    if (!pane) return

    const pending = permissions()[paneId]
    if (pending) {
      if (!isResolved(pending, [text])) return
      setPermissions((current) => {
        const next = { ...current }
        delete next[paneId]
        return next
      })
      // The agent moved on by itself, so the pane is working again.
      setWb((w) => updatePane(w, paneId, { status: "working", activity: "In esecuzione" }))
      return
    }

    const request = detectPermission(pane.lines.slice(-8).map((line) => line.text), pane.agent ?? pane.model)
    if (!request) return

    setPermissions((current) => ({ ...current, [paneId]: request }))
    setWb((w) => updatePane(w, paneId, { status: "waiting", activity: "In attesa di permesso" }))
  }

  /** Answers a pending question on the process's own stdin, where it was asked. */
  const answerPermission = (paneId: string, answer: PermissionAnswer) => {
    const session = running.get(paneId)
    if (!session) return

    session.write(answer.send)
    appendLine(paneId, `> ${answer.label}`, "shell")
    setPermissions((current) => {
      const next = { ...current }
      delete next[paneId]
      return next
    })
    setWb((w) => updatePane(w, paneId, { status: "working", activity: "In esecuzione" }))
  }

  const startProcess = async (paneId: string, agentId: string, task: string) => {
    const agent = agentById(agentId)
    const host = await getHost()
    const p = project()
    if (!agent || !agent.command || !host || !p) return

    setWb(w => updatePane(w, paneId, { status: "provisioning", activity: "Preparo albero" }))
    
    try {
      const trees = await loadWorktrees({
        host,
        projectId: p.name,
        projectPath: p.root,
        occupantsByPath: buildOccupantsByPath(wb().panes, p.root),
        now: Date.now()
      }).catch(() => [])

      const tree = await provisionSessionTree({
        host,
        projectId: p.name,
        projectPath: p.root,
        trees,
        sessionId: paneId,
        agentId,
        baseBranch: p.branch || "HEAD"
      })

      appendLine(paneId, tree.note)
      setWb(w => updatePane(w, paneId, {
        cwd: tree.cwd,
        tree: { branch: tree.branch, fidelity: tree.fidelity, note: tree.note, base: tree.baseCommit },
        status: "working",
        activity: "In esecuzione"
      }))

      const args = task && agent.promptArgs ? agent.promptArgs(task) : []
      appendLine(paneId, `${tree.cwd}> ${agent.command} ${args.join(" ")}`.trim(), "shell")
      
      const session = await host.spawn({
        command: agent.command,
        args,
        cwd: tree.cwd,
        onLine: (line, stream) => appendLine(paneId, line, stream === "err" ? "note" : "step"),
        onExit: (code) => finish(paneId, code)
      })
      
      running.set(paneId, session)
      touchRunning()
      void refetchWorktrees()

    } catch (e) {
      appendLine(paneId, String(e))
      setWb(w => updatePane(w, paneId, { status: "error", activity: "Avvio fallito" }))
    }
  }

  const addAgent = (input: { agentId: string; count: number; task: string; preset?: string }, slot: number) => {
    const id = `n${Date.now()}-${slot}`
    setWb(w => addPane(w, {
      id,
      title: input.task || `Sessione ${slot + 1} — ${input.agentId}`,
      // Provisioning, not waiting: the checkout is already being prepared, and
      // "in attesa" would read as a question this session is not asking.
      status: "provisioning",
      activity: "Inizializzazione",
      model: input.agentId,
      agent: input.agentId,
      mode: input.preset ?? "custom",
      task: input.task,
      lines: [{ kind: "note", text: input.task || "Nessun task iniziale" }],
      workspaceId: project()?.name || "workspace"
    }))
    setStarting(false)
    void startProcess(id, input.agentId, input.task)
  }

  const paneCache = new Map<string, GridPane>()
  const gridPanes = createMemo<GridPane[]>(() => {
    const state = wb()
    const activeIds = new Set(state.panes.map(p => p.id))
    for (const id of paneCache.keys()) {
      if (!activeIds.has(id)) paneCache.delete(id)
    }

    const currentPanes = state.expandedId ? state.panes.filter(p => p.id === state.expandedId) : state.panes

    return currentPanes.map(p => {
      let entry = paneCache.get(p.id)
      if (!entry) {
        entry = {
          id: p.id,
          render: () => {
            const current = () => wb().panes.find(x => x.id === p.id) ?? p

            if (current().filePath) {
              return (
                <FilePane
                  path={current().filePath!}
                  buffer={buffers()[current().id]}
                  loading={bufferLoading()[current().id]}
                  focused={current().id === wb().focusedId}
                  onFocus={() => setWb(w => ({ ...w, focusedId: current().id }))}
                  onChange={(draft) =>
                    setBuffers((all) => {
                      const buffer = all[current().id]
                      return buffer ? { ...all, [current().id]: editBuffer(buffer, draft) } : all
                    })
                  }
                  onSave={() => void saveFile(current().id)}
                  onRevert={() =>
                    setBuffers((all) => {
                      const buffer = all[current().id]
                      return buffer ? { ...all, [current().id]: revertBuffer(buffer) } : all
                    })
                  }
                  onClose={() => close(current().id)}
                  onExpand={() => setWb(w => expandPane(w, current().id))}
                />
              )
            }

            if (current().browserUrl) {
              return (
                <BrowserPane
                  id={current().id}
                  title={current().title}
                  initialUrl={current().browserUrl!}
                  focused={current().id === wb().focusedId}
                  onFocus={() => setWb(w => ({ ...w, focusedId: current().id }))}
                  onClose={() => close(current().id)}
                  onExpand={() => setWb(w => expandPane(w, current().id))}
                  /*
                   * A browser pane has no agent of its own, so what it collects
                   * goes to the session the user was last in. With nothing
                   * running there is nowhere for it to land, and saying so beats
                   * swallowing it.
                   */
                  onSendPrompt={(prompt, context) => {
                    const target = wb().panes.find((pane) => !pane.browserUrl && isRunning(pane.id))
                    if (!target) return
                    const text = context || prompt
                    appendLine(target.id, `> ${text.split("\n")[0]}`, "shell")
                    running.get(target.id)?.write(text.replace(/\n/g, " "))
                    setWb((w) => ({ ...w, focusedId: target.id }))
                  }}
                />
              )
            }

            return (
              <SessionPane
                title={current().title}
                status={current().status}
                /* What the agent says it is doing beats the label ADE guessed. */
                activity={reports()[current().id]?.activity ?? current().activity}
                elapsed={current().elapsed}
                tokens={(() => {
                  const count = reports()[current().id]?.tokens
                  return count === undefined ? current().tokens : `${formatTokens(count)} token`
                })()}
                cost={(() => {
                  const spent = reports()[current().id]?.costUsd
                  return spent === undefined ? undefined : formatCost(spent)
                })()}
                model={current().model}
                mode={current().mode}
                agent={current().agent}
                glyph={agentGlyph(current().agent ?? current().model)}
                tree={current().tree}
                onSubmit={
                  isRunning(current().id)
                    ? (line) => {
                        appendLine(current().id, `> ${line}`, "shell")
                        running.get(current().id)?.write(line)
                      }
                    : undefined
                }
                actions={
                  /*
                   * The buttons exist only when the agent actually asked
                   * something: they are its own choices, in its own order, and
                   * pressing one writes exactly the string it is waiting for.
                   */
                  permissions()[current().id]
                    ? permissions()[current().id].answers.map((answer) => ({
                        label: answer.label,
                        tone: answer.tone,
                        onClick: () => answerPermission(current().id, answer),
                      }))
                    : current().status === "error"
                      ? [
                          {
                            label: "Riprova",
                            tone: "primary" as const,
                            onClick: () => {
                              void startProcess(
                                current().id,
                                current().agent ?? current().model,
                                current().task ?? "",
                              )
                            },
                          },
                        ]
                      : undefined
                }
                lines={current().lines}
                view={paneView()[current().id] ?? "transcript"}
                onViewChange={current().cwd ? (view) => showPaneView(current().id, view) : undefined}
                diff={paneDiff()[current().id]}
                diffLoading={diffLoading()[current().id]}
                changedFiles={paneDiff()[current().id]?.files.length}
                focused={current().id === wb().focusedId}
                onFocus={() => setWb(w => ({ ...w, focusedId: current().id }))}
                onClose={() => close(current().id)}
                onExpand={() => setWb(w => expandPane(w, current().id))}
              />
            )
          }
        }
        paneCache.set(p.id, entry)
      }
      return entry
    })
  })

  const paletteChord = createMemo(() => {
    const entry = DEFAULT_BINDINGS.find((binding) => binding.commandId === "palette.open")
    return entry ? formatChord(parseChord(entry.chord, platform), platform) : ""
  })

  return (
    <div data-component="ade-shell" data-theme={theme()}>
      <header data-slot="ade-bar">
        <span data-slot="ade-brand">ade</span>
        <div data-slot="ade-views">
          <button
            type="button"
            data-slot="ade-chip"
            data-active={wb().view === "plancia" ? "true" : undefined}
            onClick={() => setWb(w => ({ ...w, view: "plancia" }))}
          >
            plancia
          </button>
          <button
            type="button"
            data-slot="ade-chip"
            data-active={wb().view === "alberi" ? "true" : undefined}
            onClick={() => setWb(w => ({ ...w, view: "alberi" }))}
          >
            alberi
          </button>
        </div>
        <ProjectBar project={project()} />
        <span data-slot="ade-count">{wb().panes.filter(p => !p.browserUrl).length} sessioni</span>

        <div data-slot="ade-spacer" />

        {/* One way in for everything the chrome does not have room for. It looks
            like a search field because that is what it is: the palette is the
            primary way to drive ADE, not a shortcut for people who know it. */}
        <button type="button" data-slot="ade-search" onClick={() => setPaletteOpen(true)}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2L14 14" stroke-linecap="round" />
          </svg>
          <span data-slot="ade-search-label">Cerca o esegui</span>
          <kbd data-slot="ade-kbd">{paletteChord()}</kbd>
        </button>

        <div data-slot="ade-spacer" />

        {/* Configuration, so it reads quieter than the two actions beside it. */}
        <div data-slot="ade-columns">
          <span data-slot="ade-label">colonne</span>
          <For each={[undefined, 1, 2, 3, 4]}>
            {(value) => (
              <button
                type="button"
                data-slot="ade-chip"
                data-active={wb().pinnedColumns === value ? "true" : undefined}
                onClick={() => setWb(w => setColumns(w, value))}
              >
                {value === undefined ? "auto" : value}
              </button>
            )}
          </For>
        </div>

        <button
          type="button"
          data-slot="ade-icon"
          onClick={() => runCommand("theme.toggle")}
          aria-label={theme() === "dark" ? "Passa al tema chiaro" : "Passa al tema scuro"}
          title={theme() === "dark" ? "Tema chiaro" : "Tema scuro"}
        >
          <Show
            when={theme() === "dark"}
            fallback={
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">
                <path d="M13 9.5A5.2 5.2 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" stroke-linejoin="round" />
              </svg>
            }
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">
              <circle cx="8" cy="8" r="3.2" />
              <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1" stroke-linecap="round" />
            </svg>
          </Show>
        </button>

        <button type="button" data-slot="ade-add" onClick={() => runCommand("browser.new")}>
          + browser
        </button>
        <button type="button" data-slot="ade-add" data-tone="primary" onClick={() => runCommand("session.new")}>
          + sessione
        </button>
      </header>

      <div data-slot="ade-body">
        <Sidebar
          workspaces={deriveWorkspaces(wb().panes)}
          selectedSessionId={wb().focusedId}
          onSelectSession={(id) => setWb(w => ({ ...w, focusedId: id }))}
          project={project()}
          selectedFilePath={selectedFile()}
          onSelectFile={(path) => void openFile(path)}
        />

        <main data-slot="ade-main">
          <Show when={wb().view === "alberi"}>
            <WorktreeBoard
              loading={worktrees.loading}
              emptyReason="Nel browser ADE non può leggere git: gli alberi di lavoro si vedono solo nell'app desktop."
              trees={worktrees() || []}
              projectName={(id) => project()?.name || id}
              now={Date.now()}
              projectBranch={project()?.branch}
              projectDirty={projectDirty()}
              notice={integrationNotice()}
              onIntegrate={hasHost() ? (input) => void integrate(input.tree, input.mode) : undefined}
              /*
               * Relocating means killing a live agent and restarting it in
               * another checkout. The board finds the move; carrying it out is
               * the same path a fresh session takes, so the session is closed
               * and started again with the work it was given.
               */
              onRelocate={(input) => {
                const pane = wb().panes.find((p) => p.id === input.occupant.sessionId)
                if (!pane) return
                close(pane.id)
                addAgent(
                  { agentId: pane.agent ?? pane.model, count: 1, task: pane.task ?? "", preset: pane.mode },
                  0,
                )
              }}
            />
          </Show>

          <Show when={wb().view === "plancia"}>
            {/* Without a project there is nothing to run an agent in, and in the
                browser there is no way to run one at all. Offering the launch
                screen there would be offering a button that cannot work. */}
            <Show
              when={project()}
              fallback={<EmptyProject hasHost={hasHost()} onOpenProject={() => runCommand("project.open")} />}
            >
              <Show
                when={wb().panes.length > 0 && !starting()}
                fallback={
                  <SessionNew
                    workspace={project()?.name || "workspace"}
                    path={project()?.root || ""}
                    /* Cancelling is only offered when there is something to go
                       back to; on an empty workbench it would lead nowhere. */
                    onClose={wb().panes.length > 0 ? () => setStarting(false) : undefined}
                    onLaunch={(input) => {
                      for (let i = 0; i < input.count; i += 1) addAgent(input, i)
                    }}
                  />
                }
              >
                <SessionGrid
                  panes={gridPanes()}
                  focused={wb().focusedId}
                  onFocus={(id) => setWb(w => ({ ...w, focusedId: id }))}
                  onClose={close}
                  columns={wb().pinnedColumns}
                />
              </Show>
            </Show>
          </Show>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen()}
        commands={allCommands()}
        onRun={runCommand}
        onClose={() => setPaletteOpen(false)}
        platform={platform}
        emptyLabel="Nessun comando trovato."
      />
    </div>
  )
}
