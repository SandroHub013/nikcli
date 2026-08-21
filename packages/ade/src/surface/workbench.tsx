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
import { parseTheme, resolveTheme, serializeTheme, type Theme } from "../theme"

const DEFAULT_PREVIEW_URL = "http://localhost:3000"

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
      if (id) {
        e.preventDefault()
        runCommand(id)
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
  }

  const appendLine = (id: string, text: string, kind: "step" | "shell" | "note" = "note") => {
    setWb(w => {
      const pane = w.panes.find(p => p.id === id)
      if (!pane) return w
      return updatePane(w, id, { lines: [...pane.lines, { kind, text }].slice(-200) })
    })
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
        tree: { branch: tree.branch, fidelity: tree.fidelity, note: tree.note },
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
                activity={current().activity}
                elapsed={current().elapsed}
                tokens={current().tokens}
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
                   * There is no "grant permission" button, and there will not be
                   * one until ADE can recognise a permission request in an
                   * agent's output. A pair of buttons that write a word nobody
                   * asked for into stdin is worse than no buttons: it looks like
                   * an answer and is not one. The prompt below the transcript is
                   * the real answer channel, and it goes to the process.
                   */
                  current().status === "error"
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
          onSelectFile={setSelectedFile}
        />

        <main data-slot="ade-main">
          <Show when={wb().view === "alberi"}>
            <WorktreeBoard
              loading={worktrees.loading}
              emptyReason="Nel browser ADE non puo' leggere git: gli alberi si vedono solo nell'app desktop."
              trees={worktrees() || []}
              projectName={(id) => project()?.name || id}
              now={Date.now()}
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
