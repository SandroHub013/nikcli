/**
 * VoiceHost defines the contract between the voice control subsystem and ADE.
 *
 * Why this interface exists:
 * The voice layer must not know internal implementation details of ADE (such as
 * Solid signals, MobX stores, or internal Workbench mutations). Otherwise, any
 * architectural refactor or UI redesign in ADE would break voice commands.
 *
 * VoiceHost acts as an anti-corruption boundary: it exposes only high-level,
 * intention-oriented operations and spoken state summaries, isolating voice
 * recognition from ADE surface internals.
 */

/**
 * Mirrors ADE's own pane status union.
 *
 * Declared here rather than imported: the whole point of this file is that the
 * voice layer names ADE's concepts without reaching into ADE's modules. Five
 * string literals are a cheaper price than a dependency on a surface type.
 */
export type PaneStatus = "idle" | "provisioning" | "working" | "waiting" | "done" | "error"

/**
 * ADE's top-level sections, named here for the same reason as `PaneStatus`.
 *
 * - `agent` — this assistant's own console: what it was asked, what it did.
 * - `code`  — the grid of agent terminals. Was called "plancia".
 * - `chat`  — a plain conversation with a language model, no terminal behind it.
 * - `bot`   — the roster of named, persistent bots and the rooms they share.
 *
 * Kept exactly in step with `surface/state.ts`. It held `alberi` for a while
 * after the worktree board was removed, and nothing caught it: a mirror that
 * is a *superset* of the real union still typechecks, so the stale member sat
 * there until a new section made the union no longer a superset. If a section
 * is added there, it is added here in the same commit.
 */
export type AdeView = "agent" | "code" | "chat" | "bot"

/**
 * High-level summary of a pane presented to the voice subsystem.
 */
export interface PaneSummary {
  /** Unique pane identifier in ADE. */
  id: string
  /** Human-readable title of the pane or task. */
  title: string
  /** Current execution status of the pane. */
  status: PaneStatus
  /** 1-based visual index as perceived by the user on screen. */
  index: number
  /** Whether the pane currently has an active background process. */
  hasLiveProcess: boolean
  /** Whether this pane is displaying an embedded browser preview. */
  isBrowser: boolean
  /** Whether this pane is an editor view for a project file. */
  isFile: boolean
}

/**
 * Snapshot of ADE's operational state formatted for spoken readout in Italian.
 */
export interface VoiceStateSnapshot {
  /** Total count of sessions. */
  totalSessions: number
  /** Number of sessions actively executing tasks. */
  workingSessions: number
  /** Number of sessions waiting for user input or permission. */
  waitingSessions: number
  /** Number of sessions that have finished. */
  doneSessions: number
  /** Number of sessions in an error state. */
  errorSessions: number
  /** Currently focused pane summary, if any. */
  focusedPane?: PaneSummary
  /** Name or path of the open project. */
  activeProject?: string
  /** Current active layout view in ADE. */
  currentView: AdeView
  /** Pre-formatted Italian description ready for text-to-speech output. */
  spokenSummary: string
}

/**
 * The complete capability surface ADE must expose to be 100% voice controllable.
 */
export interface VoiceHost {
  /**
   * Run an existing ADE command by identifier:
   * "palette.open", "session.new", "project.open", "pane.close", "pane.expand",
   * "view.toggle", "theme.toggle", "browser.new", "process.kill",
   * and "project.recent.<root>".
   */
  runCommand(id: string): Promise<void>

  /**
   * List all currently open panes with 1-based user indexes and status.
   */
  listPanes(): PaneSummary[]

  /**
   * The agents this installation can actually start.
   *
   * The planner needs it for two different jobs: to know that "claude" is a
   * real thing to ask for, and to refuse "avvia quattro sessioni di copilot"
   * with the truth rather than by starting nothing and saying it worked. A
   * catalogue invented by a language model is the failure mode here.
   */
  listAgents?(): { id: string; label: string; available: boolean }[]

  /** The projects that can be opened by name, so a plan can name one. */
  listProjects?(): { name: string; root: string; isOpen: boolean }[]

  /**
   * Opens one new agent session, with the task it should start on.
   *
   * Parameterised, unlike `runCommand("session.new")`, which is the whole
   * reason a spoken "avvia quattro sessioni claude, una sul parser, una sui
   * test" could not be carried out: the command surface had no place to put
   * "which agent", "how many", or "about what". Four sessions with four
   * different tasks are four calls, because each one carries its own task —
   * a count parameter would force them all to share one.
   */
  startSession?(input: { agent: string; task?: string; project?: string }): Promise<{ paneId: string; title: string }>

  /**
   * Focus a specific pane by its ID.
   */
  focusPane(paneId: string): void

  /**
   * Send a dictated task or prompt message directly to an agent session.
   */
  sendPrompt(paneId: string, text: string): Promise<void>

  /**
   * Waits for the session to finish answering, and reports what it said.
   *
   * Why this is part of the contract: without it a voice *agent* is only a
   * dictation machine. `sendPrompt` submits and returns, the assistant says
   * "l'ho inviato", and the answer — the thing the user actually asked for —
   * appears silently on a screen they may not be looking at. Nothing else here
   * can observe a pane over time, so nothing else can close that loop.
   *
   * Optional because a host may have no way to watch a transcript; a caller
   * that finds it missing simply does not speak replies.
   *
   * Returns the lines the pane added *after* the call, and why the watch
   * ended — `silent` (nothing ever came) and `timeout` (still going when the
   * ceiling hit) are different things to say out loud.
   */
  awaitReply?(
    paneId: string,
    options?: { signal?: AbortSignal },
  ): Promise<{
    lines: { kind: "step" | "shell" | "note" | "diff" | "error"; text: string }[]
    reason: "settled" | "error" | "silent" | "timeout" | "aborted" | "gone"
  }>

  /**
   * Insert text into a pane's composer without submitting it.
   *
   * Why this exists alongside sendPrompt:
   * sendPrompt immediately submits the dictated message to the agent session,
   * triggering execution. In contrast, insertText places the transcribed text
   * into the target pane's input composer for manual review and editing without
   * automatically executing the prompt.
   */
  insertText(paneId: string, text: string): Promise<void>

  /**
   * Open a specific file path within the project workspace.
   */
  openFile(path: string): Promise<void>

  /**
   * Search for symbols or files across the active project.
   */
  searchProject(query: string): Promise<{ path: string; line?: number }[]>

  /**
   * Switch the view inside a pane between transcript stream and diff inspector.
   */
  setPaneView(paneId: string, view: "transcript" | "diff"): void

  /**
   * Navigate an embedded browser pane to a target URL.
   */
  browserNavigate(paneId: string, url: string): void

  /**
   * Respond to an agent's interactive permission confirmation.
   */
  answerPermission(paneId: string, answer: "allow" | "deny"): void

  /**
   * Configure the number of grid columns on the workbench.
   */
  setColumns(columns?: number): void

  /**
   * Switch the workbench to one of ADE's top-level sections.
   */
  setView(view: AdeView): void

  /**
   * Scroll the transcript in a target pane up (negative delta) or down (positive delta).
   */
  scrollTranscript(paneId: string, delta: number): void

  /**
   * Generate a snapshot of ADE state formatted for spoken delivery in Italian.
   */
  describeState(): VoiceStateSnapshot
}
