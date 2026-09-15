import { onMount, onCleanup, on, createSignal, createEffect, createMemo, createResource, Show, For } from "solid-js"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import { getHost, stripAnsi, type SpawnedSession } from "../host/shell"
import { every } from "../host/every"
import { isRemoteRoot, remoteRoot, sshArgs, sshAsking, type RemoteTarget } from "../remote/ssh"
import { RemoteSpaceDialog } from "../remote/remote-dialog"
import { discoverProject, openProject, type Project } from "../host/project"
import { addRecent, serializeRecents, parseRecents, type RecentEntry } from "../host/recent"
import { pathEquals } from "../host/path"
import { serializeWorkspace, parseWorkspace, type WorkspaceState } from "../session/persist"
import { DEFAULT_BINDINGS, resolveDefaultBindings } from "../keyboard/bindings"
import { formatChord, parseChord } from "../keyboard/keymap"
import { CommandPalette } from "../command/palette"
import { SessionNew } from "../session-new/session-new"
import { AGENTS, agentById, agentLabel } from "../session-new/agents"
import {
  DEFAULT_MAX_DEPTH,
  checkName,
  depthOf,
  descendants,
  excludeWithAde,
  modelArgs,
  nameTaken,
  withoutModel,
  resultsDir,
  slugify,
  worktreeArgs,
  worktreePlan,
} from "../session/orchestra"
import { detectAgents } from "../session-new/availability"
import { RESUME, planFork, planRestore, planResume, planStart, type ResumePlan } from "../session-new/resume"
import { followReports, newNonce } from "../session-new/agent-link"
import { HOOK_TARGETS, hookTarget, readHookStatus, refreshHookScript, type HookHost, type HookStatus } from "../session-new/agent-hooks"
import { AgentHooksSection } from "../session-new/agent-hooks-panel"
import { BotSection, GridSection, McpSection, ProviderSection, RoutineSection, SkillsSection } from "../settings/sections"
import { willLaunch, type LaunchEntry } from "../session-new/launch"
import type { PresetId } from "../session-new/preset"

/** What a slot is called in a pane title, when the task does not name it. */
const ROLE_LABEL: Record<LaunchEntry["role"], string> = {
  agent: "Sessione",
  reviewer: "Revisione",
  shell: "Terminale",
}
import { Sidebar } from "../sidebar"
import { SessionGrid } from "../grid/session-grid"
import { requestRename } from "../grid/rename"
import { EmptyProject } from "./empty-project"
import { ProjectBar } from "./project-bar"
import { NikChromeLogo } from "./nik-chrome-logo"
const isTauriDesktop = () =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)

/**
 * On macOS the window keeps its native traffic lights, drawn over the bar
 * (`TitleBarStyle::Overlay` in lib.rs), so the bar draws no controls of its
 * own and leaves room for the lights on the left.
 */
const isMacOS = () => typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent ?? "")

async function adeWindowMinimize() {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("ade_window_minimize")
  } catch {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      await getCurrentWindow().minimize()
    } catch (e) {
      console.error("Failed to minimize window:", e)
    }
  }
}

async function adeWindowToggleMaximize() {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("ade_window_toggle_maximize")
  } catch {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      await getCurrentWindow().toggleMaximize()
    } catch (e) {
      console.error("Failed to toggle maximize window:", e)
    }
  }
}

async function adeWindowClose() {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("ade_window_close")
  } catch {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      await getCurrentWindow().close()
    } catch (e) {
      console.error("Failed to close window:", e)
    }
  }
}
import {
  createWorkbench,
  type Pane,
  addPane,
  closePane,
  updatePane,
  expandPane,
  setColumns,
  deriveWorkspaces,
  toWorkspaceState,
  fromWorkspaceState,
  sessionsToResume,
  nextView,
  ADE_VIEWS,
  ADE_VIEW_LABELS,
  type Workbench as WorkbenchState,
} from "./state"
import { AgentConsole } from "../agent/agent-console"
import { Chat } from "../chat/chat"
import { BotsMain, BotsRoster } from "../bots/bots"
import type { AgentFile } from "../bots/nikcli"
import type { Runner } from "../bots/runners"
import { botLaunch } from "../bots/store"
import { buildCommands, keepsPaletteOpen } from "./commands"
import { createAdePluginRuntime } from "../plugin/runtime"
import { createManagerPlugin } from "../plugin/built-in/manager"
import { importPluginModule } from "../plugin/loader"
import { PluginSection } from "../plugin/pane"
import { parseCommandId } from "../plugin/trust"
import { CONSENT_KEY, consentQuestion, hasConsent, withConsent } from "../plugin/consent"
import { toPluginSession } from "../plugin/session"
import type { DiscoveryIO } from "../plugin/discovery"
import {
  markSaved,
  openBuffer,
  saveBlockedReason,
} from "../editor"
import {
  detectPermission,
  isResolved,
  type PermissionAnswer,
} from "../session/permission"
import { readReportLine } from "../session/report"
import { asOneLine, asSubmittedLine } from "../session/typing"
import { searchPaths, walkProject } from "../search"
import {
  DEFAULT_MAX_SPAWNED,
  USAGE,
  agentsTable,
  briefOf,
  byProject,
  formatCancel,
  formatNudge,
  formatUpdate,
  parseActivity,
  parseOpenRequests,
  shouldRering,
  type Activity,
  requestState,
  requestsTable,
  shouldNudge,
  type OpenRequest,
  formatDelivery,
  formatLateReply,
  formatRequest,
  parseMessage,
  resolveAgent,
  resolveTarget,
  sessionsTable,
  verifySender,
  type MailPane,
  type Message,
} from "../session/mailbox"
import {
  applyKv,
  emptySpace,
  memoryAddReply,
  memoryEntry,
  parseKvStore,
  statsTable,
  withMemoryEntry,
  type TokenUsage,
} from "../session/shared"
import { displayArgs, introArgs, withIntro } from "../session-new/intro"
import { createThemeState } from "./theme-state"
import { createPaneRecords } from "./pane-records"
import { createAutosave } from "./autosave"
import { createPaneRenderer } from "./pane-renderer"
import { Splash } from "../splash/splash"
import { createPanelRouter } from "../panels/router"
import { PLAYABLE_EXTENSIONS } from "../video/video"
import {
  createMicMeter,
  createVoiceEngine,
  createWebSpeechSpeaker,
  createFakeSpeaker,
  loadVoiceSettings,
  saveVoiceSettings,
  summarizeVoiceShortcutConflicts,
  NikCube,
  VoiceHud,
  VoiceOrb,
  VoiceSettingsPanel,
  type VoiceEngine,
  type VoiceSettings,
} from "@nikcli-ai/voice"
import { ShotTray, createShotSource } from "../shots"
import { disposeTerminal, noteInTerminal, refreshTerminalThemes, writeToTerminal } from "../terminal/registry"
import { decideOpening } from "../session/opening"
import { cleanTranscriptLine } from "../session/transcript-line"
import { createRawWindows } from "../session/raw-window"
import { NEW_PANE_ITEMS, showsNewPane, type NewPaneItem } from "./new-pane"
import {
  addNotice,
  bellTone,
  dismissNotice,
  markAllRead,
  unreadCount,
  type Notice,
  type NoticeKind,
} from "./notifications"
import { startUpdateWatch } from "../update/watch"
import { isReleasePage } from "../update/release"
import { createAdeVoiceHost } from "../voice/host"
import { createPushToTalkHandler, resolveVoiceOrAdeKey } from "../voice/shortcuts"
import {
  GLOBAL_VOICE_EVENT,
  modeForGlobalChord,
  readGlobalVoicePayload,
  toTauriChord,
} from "../voice/global-shortcut"

const DEFAULT_PREVIEW_URL = "http://localhost:3000"

/** Every command `runCommand` below actually implements. */
const HANDLED_COMMANDS = new Set([
  "palette.open",
  "session.new",
  "project.open",
  "pane.close",
  "pane.expand",
  "pane.rename",
  "view.toggle",
  "theme.toggle",
  "browser.new",
  "process.kill",
  "voice.toggle",
  "voice.settings",
])

function isHandledCommand(id: string): boolean {
  return HANDLED_COMMANDS.has(id) || id.startsWith("project.recent.")
}

/**
 * Makes every pane id different from every other, whatever the clock says.
 *
 * Ids were `n${Date.now()}-${index}`, unique within one launch because the
 * form numbers its slots, and not unique across launches: two sessions started
 * in the same millisecond with the same slot number — four spoken sessions, or
 * one started just after a close freed an index — produced the same string
 * twice. Nothing checks for it. `addPane` appends, `closePane` would then drop
 * both, `updatePane` would write to both, and the terminal registry would hand
 * them a single xterm. A counter makes the case impossible.
 */
let paneSequence = 0

/**
 * How much of a session's output a pane keeps in memory.
 *
 * The scrollback the user can actually reach; what goes to disk is bounded
 * separately by `transcript-budget`.
 */
const MAX_PANE_LINES = 200

/**
 * The shortest time the startup screen stays up.
 *
 * A warm start finishes in under a tenth of a second, and a screen that
 * appears and vanishes in that time reads as a glitch. Long enough to be
 * looked at, short enough not to be waited for.
 */
const SPLASH_FLOOR_MS = 7000

export function Workbench() {
  const platform = navigator.userAgent.includes("Mac") ? "mac" : "other"
  const bindings = resolveDefaultBindings(platform)
  
  /*
   * The workbench is a store, and `wb()` hands back the store itself.
   *
   * It was one signal holding every pane and every transcript, so a single
   * line of output from one agent replaced the whole object and woke every
   * consumer of `wb()` — the sidebar's project list, the tab strip's session
   * count, the autosave, the grid — several times a second, with four agents
   * running. A store notifies per property: pushing a line onto one pane's
   * transcript reaches the component drawing that transcript and nobody else.
   *
   * The accessor shape stays `wb()` so the reads below are unchanged, and it
   * still works: what tracks is the property read on the proxy it returns,
   * not the call. The one thing that no longer tracks is reading `wb()` and
   * nothing else, which the autosave used to do — see `revision`.
   */
  const [wbStore, setWbStore] = createStore<WorkbenchState>(createWorkbench())
  const wb = () => wbStore

  /**
   * Bumped by every write to the workbench.
   *
   * The autosave has to run on any change at all, and with a store there is no
   * single thing to read that means "anything moved". `equals: false` makes
   * every bump a notification even when the number repeats.
   */
  const [revision, setRevision] = createSignal(0, { equals: false })

  /**
   * Applies a whole new workbench, keeping the parts that did not change.
   *
   * The reducers in `state.ts` are pure and return a fresh object; `reconcile`
   * turns that back into the smallest set of writes against the store, keyed
   * by pane id, so replacing the object does not invalidate every pane in it.
   */
  const setWb = (next: WorkbenchState | ((current: WorkbenchState) => WorkbenchState)) => {
    const current = unwrap(wbStore)
    const value = typeof next === "function" ? next(current) : next
    if (value !== current) setWbStore(reconcile(value, { key: "id" }))
    setRevision((n) => n + 1)
  }
  /*
   * Which panes have a terminal worth drawing.
   *
   * Not derived from `running`: a session that has exited still has scrollback
   * the user is reading, and a pane restored from a previous run has none at
   * all. Membership starts at the first byte and ends when the pane closes.
   */
  const [liveTerminals, setLiveTerminals] = createSignal<Set<string>>(new Set())
  /*
   * Started before the host is known to exist, because the check is the same
   * one the host module already makes and asking twice would only mean the
   * tray misses the screenshots taken while it waited for an answer.
   */
  const shotSource = createShotSource(
    typeof window !== "undefined" &&
      "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>),
  )
  const [project, setProject] = createSignal<Project>()
  const [recents, setRecents] = createSignal<RecentEntry[]>([])

  /**
   * What the startup screen is saying, or nothing once it is done.
   *
   * A string rather than a flag: the splash is up for as long as ADE is
   * genuinely still finding things, and telling the user *which* thing is
   * the difference between a wait and a hang.
   */
  const [booting, setBooting] = createSignal<string | undefined>("cerco l'host")
  let skipSplashResolver: (() => void) | undefined
  const dismissSplash = () => {
    if (skipSplashResolver) {
      skipSplashResolver()
      skipSplashResolver = undefined
    }
    setBooting(undefined)
  }

  /**
   * The sidebar's project list, rebuilt only when it would differ.
   *
   * A memo rather than a call in the JSX: it reads a handful of fields per
   * pane — id, title, status, workspaceId, activity — and with those tracked
   * one at a time, a pane printing output does not rebuild the list, and the
   * sidebar is not handed a new array to diff for every line.
   */
  const workspaces = createMemo(() => {
    const currentProject = project()
    const list: Array<{ root: string; name: string; branch?: string }> = recents().map((r) => ({
      root: r.root,
      name: r.name,
      branch: (r.root === currentProject?.root || r.name === currentProject?.name) ? currentProject?.branch : undefined,
    }))
    if (currentProject && !list.some((p) => p.name === currentProject.name || p.root === currentProject.root)) {
      list.unshift({
        root: currentProject.root,
        name: currentProject.name,
        branch: currentProject.branch,
      })
    }
    return deriveWorkspaces(wb().panes, list)
  })
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [hasHost, setHasHost] = createSignal(false)
  const [selectedFile, setSelectedFile] = createSignal<string | undefined>()
  // The launch screen is a state, not an empty grid: it has to be reachable with
  // six sessions already running, which is exactly when a seventh is wanted.
  const [starting, setStarting] = createSignal(false)
  const [remoteOpen, setRemoteOpen] = createSignal(false)
  const themeState = createThemeState()
  const theme = themeState.theme

  /*
   * xterm is handed concrete colours, so it cannot follow the theme on its own.
   *
   * The attribute below drives the whole stylesheet, but a terminal resolved
   * its palette once and keeps it: the repaint has to be pushed. Deferred by a
   * frame because this effect runs before the new `data-theme` has been
   * committed to the DOM, and the probe reads the cascade as it stands.
   */
  createEffect(() => {
    theme()
    const frame = requestAnimationFrame(() => refreshTerminalThemes())
    onCleanup(() => cancelAnimationFrame(frame))
  })

  /*
   * Everything keyed by pane id, in one place so it is forgotten in one place.
   * See `pane-records.ts` for why that matters.
   */
  const records = createPaneRecords()
  const { reports, buffers, bufferLoading, permissions } = records

  /*
   * One line for things the user has to be told but must not be stopped for.
   *
   * It used to be the worktree board's status line, which is where the file
   * editor borrowed it from. With the board gone those messages had nowhere
   * left to appear, and a save that failed would have failed in silence — so
   * the notice is now the shell's own, rendered above the section.
   */
  const [notice, setNotice] = createSignal<string>()

  /*
   * The same messages, kept.
   *
   * The strip above is transient by design — it is for the thing that just
   * happened — and everything it showed was lost the moment the next one
   * arrived or the user dismissed it. The bell is where they accumulate, so
   * a save that failed while the user was reading another session is still
   * findable afterwards.
   */
  const [notices, setNotices] = createSignal<Notice[]>([])
  const [noticesOpen, setNoticesOpen] = createSignal(false)
  const [newPaneOpen, setNewPaneOpen] = createSignal(false)

  /** Says it once, in both places: the strip now, the bell afterwards. */
  const report = (text: string, kind: NoticeKind = "error", paneId?: string) => {
    setNotice(text)
    setNotices((list) => addNotice(list, { kind, text, at: Date.now(), ...(paneId ? { paneId } : {}) }))
  }

  /*
   * What the agents actually wrote, for the detectors that search it.
   * See `session/raw-window.ts`: the transcript is the cleaned copy and is
   * the wrong thing to run a regex over.
   */
  const rawWindows = createRawWindows()

  /*
   * Where an agent's `@ade …` line ends up. See `panels/router.ts`.
   *
   * The registry is here and not inside a pane because the agent asking is
   * not in the pane being asked: a session types the request on its own
   * stdout, and the panel that answers is a different tile in the grid.
   */
  const panels = createPanelRouter()

  /**
   * Tells one session which panels it can drive.
   *
   * Typed into the pty rather than only written to the transcript: the agent
   * reads its stdin, not ADE's interface, and a capability it is never told
   * about is a channel with no door.
   */
  const announcePanels = (paneId: string, panel: string) => {
    const session = running.get(paneId)
    if (!session) return
    for (const line of panels.greeting(panel)) {
      session.write(asSubmittedLine(line))
      appendLine(paneId, line, "note")
    }
  }

  /** Announces a newly opened panel to every session currently running. */
  const announceToAll = (panel: string) => {
    for (const id of running.keys()) announcePanels(id, panel)
  }

  /** The native picker, narrowed to what a webview will actually play. */
  const pickVideo = async () => {
    const host = await getHost()
    return host?.pickFile?.({
      title: "Scegli un video",
      filters: [{ name: "Video", extensions: [...PLAYABLE_EXTENSIONS] }],
    })
  }

  /**
   * Writes a captured frame next to the project, and says where it went.
   *
   * Inside the project rather than the screenshots folder: the frame is
   * evidence about the thing being built, the agent is about to be handed
   * the path, and `write_bytes` only writes inside the roots this window has
   * declared — which the screenshots folder is not.
   */
  const captureFrame = async (name: string, png: Uint8Array): Promise<string> => {
    const host = await getHost()
    const root = project()?.root
    if (!host?.writeBytes || !root) throw new Error("nessun progetto aperto in cui salvare")
    const path = `${root.replace(/[/\\]+$/, "")}/.ade/frames/${name}`
    const failure = await host.writeBytes(path, png)
    if (failure) throw new Error(failure)
    return path
  }

  /**
   * Acts on one line of agent output, if it was addressed to a panel.
   *
   * The answer goes back into the pty, not only into the transcript: the
   * agent is blocked on its own stdin waiting for it, and a reply written
   * where only the user can see it leaves the session stopped forever.
   */
  const handlePanelRequest = async (paneId: string, line: string) => {
    const handled = await panels.handle(line)
    if (!handled) return
    // Written to the transcript too, because what an agent did to a panel is
    // something the user has to be able to see afterwards.
    appendLine(paneId, handled.reply, "note")
    running.get(paneId)?.write(asSubmittedLine(handled.reply))
  }

  const running = new Map<string, SpawnedSession>()
  const [runningTick, setRunningTick] = createSignal(0)
  const touchRunning = () => setRunningTick(n => n + 1)
  const isRunning = (id: string) => { runningTick(); return running.has(id) }

  /*
   * Messages between sessions. See `session/mailbox.ts` and `mailbox.rs`.
   *
   * The sessions are the agent panes in grid order — the same order, and so
   * the same numbers, that `ade-msg list` prints — and only a running one
   * can receive: typing into a pane with no process reaches nobody.
   */
  const mailPanes = (): MailPane[] =>
    // Grouped by project, which is also the order `ade-msg list` numbers them in.
    byProject(
      wb()
        .panes.filter((pane) => !pane.browserUrl && !pane.filePath && !pane.videoPath && !pane.plugin && (pane.agent ?? pane.model))
        .map((pane) => ({
          id: pane.id,
          title: pane.title,
          agent: pane.agent ?? pane.model,
          status: running.has(pane.id) ? pane.status : "chiusa",
          project: pane.workspaceId,
        })),
    )

  /** Long enough for a TUI's paste detection to close before Enter arrives. */
  const SUBMIT_DELAY_MS = 400
  let delivering = false

  const deliverMail = async () => {
    // One pass at a time: a pass now waits between text and Enter, and two
    // overlapping passes would interleave two messages in one input box.
    if (delivering) return
    delivering = true
    try {
      await deliverPending()
    } finally {
      delivering = false
    }
  }

  /*
   * The text, and the Enter on its own a moment later.
   *
   * Written together, the whole line and its carriage return reach the CLI in
   * one burst, and Claude Code and codex take a burst for a paste: the return
   * becomes part of the pasted text and the line sits in the input box waiting
   * for someone to press Enter. A keystroke that arrives after the paste has
   * settled is a keystroke. False when the session went away in between.
   */
  const typeLine = async (session: SpawnedSession, text: string): Promise<boolean> => {
    const line = asOneLine(text)
    const paneId = [...running.entries()].find(([, live]) => live === session)?.[0]
    /*
     * A paste, said as one, when the CLI has asked for that. Claude Code and
     * codex switch bracketed paste on, and then text between the markers is
     * a paste by declaration rather than by guesswork about timing, and the
     * Enter after it is a keystroke at once. Otherwise: the text, and Enter
     * after a wait that grows with the line — a thousand characters with the
     * reply contract were still being taken in when a fixed 400 ms Enter came.
     */
    const bracketed = paneId !== undefined && bracketedPaste.get(paneId) === true
    const typedAt = Date.now()
    session.write(bracketed ? `${ESC}[200~${line}${ESC}[201~` : line)
    await new Promise((resolve) => setTimeout(resolve, bracketed ? 120 : Math.min(2500, SUBMIT_DELAY_MS + line.length)))
    if (![...running.values()].includes(session)) return false
    session.write("\r")
    if (paneId !== undefined) void confirmSubmitted(paneId, session, typedAt)
    return true
  }

  const ESC = String.fromCharCode(27)

  /** Whether each pane's program has bracketed paste on, from the mode switches in its own output. */
  const bracketedPaste = new Map<string, boolean>()
  const noteBracketedPaste = (paneId: string, chunk: string) => {
    const on = chunk.lastIndexOf(`${ESC}[?2004h`)
    const off = chunk.lastIndexOf(`${ESC}[?2004l`)
    if (on >= 0 || off >= 0) bracketedPaste.set(paneId, on > off)
  }

  /**
   * Makes sure a typed line became a turn, where the CLI's hooks can say so.
   *
   * `UserPromptSubmit` runs the moment a prompt is sent. If it has not run
   * within a few seconds the line is still in the input box, and Enter goes
   * again — twice at most, never over a permission prompt, and not at all for
   * a CLI without the hook, where no answer is not evidence of anything.
   */
  const confirmSubmitted = async (paneId: string, session: SpawnedSession, typedAt: number) => {
    const host = await getHost()
    const nonce = paneNonces.get(paneId)
    if (!host?.readAgentActivity || !nonce || !hooked(paneId)) return
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      if (running.get(paneId) !== session || permissions()[paneId]) return
      const resumeId = wb().panes.find((pane) => pane.id === paneId)?.resumeId
      const activity = parseActivity(await host.readAgentActivity(nonce), resumeId)
      if (activity && activity.at >= typedAt) {
        activityOf.set(paneId, activity)
        return
      }
      session.write("\r")
      appendLine(paneId, "Invio ripetuto: il messaggio non era partito", "note")
    }
  }

  /** Messages taken from the outbox and not delivered yet, oldest first. */
  const mailQueue: { id: string; message: Message; at: number }[] = []

  /*
   * What survives a restart, in localStorage: the requests still waiting for
   * an answer, and which session started which with `spawn`. Pane ids survive
   * a restore, so both still point at the right panes afterwards.
   */
  const REQUESTS_KEY = "ade.mailbox.requests"
  const SPAWNED_KEY = "ade.mailbox.spawned"
  const KV_KEY = "ade.mailbox.kv"
  const readStored = (key: string): string | null => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }
  const writeStored = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value)
    } catch {}
  }

  /** The `ask` and `spawn` requests still waiting for a reply. */
  const openRequests = new Map<string, OpenRequest>(parseOpenRequests(readStored(REQUESTS_KEY)).map((request) => [request.id, request]))
  const saveRequests = () => writeStored(REQUESTS_KEY, JSON.stringify([...openRequests.values()]))
  /*
   * Restored requests count their grace from now, not from when they were
   * made: their sessions are being reopened, and "not running" during that is
   * not "closed".
   */
  const loadedAt = Date.now()

  /** Sessions started with `spawn`: pane id → the pane that started it, the only one that may close it. */
  const spawnedBy = new Map<string, string>(
    (() => {
      try {
        const raw: unknown = JSON.parse(readStored(SPAWNED_KEY) ?? "{}")
        return raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string") : []
      } catch {
        return []
      }
    })(),
  )
  const saveSpawned = () => writeStored(SPAWNED_KEY, JSON.stringify(Object.fromEntries(spawnedBy)))

  /** The shared key-value store, one space per project name. See `session/shared.ts`. */
  let kvStore = parseKvStore(readStored(KV_KEY))
  const saveKv = () => writeStored(KV_KEY, JSON.stringify(kvStore))

  /** Token usage per pane, from each session's transcript, for `ade-msg stats`. */
  const usageOf = new Map<string, TokenUsage>()
  let publishedStats = ""
  const refreshUsage = async () => {
    const host = await getHost()
    if (!host?.transcriptUsage || !host.mailboxPublish) return
    const rows: { title: string; agent: string; project?: string; usage: TokenUsage }[] = []
    for (const pane of wb().panes) {
      const agent = pane.agent ?? pane.model
      if ((agent !== "claude-code" && agent !== "codex") || !pane.resumeId || !pane.cwd || isRemoteRoot(pane.cwd)) continue
      const usage = await host.transcriptUsage(agent, pane.resumeId, pane.cwd)
      if (usage) usageOf.set(pane.id, usage)
      const known = usageOf.get(pane.id)
      if (known) rows.push({ title: pane.title, agent, project: pane.workspaceId, usage: known })
    }
    const table = statsTable(rows)
    if (table !== publishedStats) {
      publishedStats = table
      await host.mailboxPublish(table, "stats").catch(() => {})
    }
  }

  /** When each pane last printed anything: a session silent for a while has stopped working. */
  const lastOutputAt = new Map<string, number>()

  /** Each running pane's hook nonce, and the last turn start or end its hook reported. */
  const paneNonces = new Map<string, string>()
  const activityOf = new Map<string, Activity>()
  const hooked = (paneId: string) => {
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    return paneNonces.has(paneId) && Boolean(hookTarget(pane?.agent ?? pane?.model ?? "")?.activityEvents?.length)
  }

  /*
   * One secret per spawn, in that process tree's environment only. A pane id
   * is public — `ade-msg list` prints them — so a `from` counts as the sender
   * only when the token that came with it is this pane's.
   */
  const paneTokens = new Map<string, string>()
  const mintPaneToken = (paneId: string) => {
    const token = newNonce()
    paneTokens.set(paneId, token)
    return token
  }

  /** How long a reply may sit unclaimed before it is typed into the caller instead. */
  const CLAIM_WINDOW_MS = 3000
  /** How long a session that replied with `--close` keeps running, so its own `ade-msg reply` can finish. */
  const AUTO_CLOSE_DELAY_MS = 2500

  const SPAWNABLE = AGENTS.filter((agent) => agent.id !== "terminal")

  /** The cap on sessions `spawn` keeps open at once; `ade.mailbox.maxSpawned` in localStorage overrides it. */
  const maxSpawned = () => {
    const stored = Number(readStored("ade.mailbox.maxSpawned"))
    return Number.isInteger(stored) && stored > 0 ? stored : DEFAULT_MAX_SPAWNED
  }

  const targetOf = (request: OpenRequest) => ({
    running: running.has(request.to),
    permissionPending: Boolean(permissions()[request.to]),
    lastOutputAt: lastOutputAt.get(request.to),
    activity: activityOf.get(request.to),
    hooked: hooked(request.to),
  })

  /** Refreshes the turn activity of the sessions that owe an answer; the others are not asked. */
  const readActivities = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>) => {
    if (!host.readAgentActivity) return
    const targets = new Set([...openRequests.values()].map((request) => request.to))
    for (const paneId of targets) {
      const nonce = paneNonces.get(paneId)
      if (!nonce || !hooked(paneId)) continue
      const resumeId = wb().panes.find((pane) => pane.id === paneId)?.resumeId
      const activity = parseActivity(await host.readAgentActivity(nonce), resumeId)
      if (activity) activityOf.set(paneId, activity)
    }
  }
  const stateOf = (request: OpenRequest, now = Date.now()) =>
    requestState({ ...request, at: Math.max(request.at, loadedAt) }, targetOf(request), now)

  /** The last state written for each request, so a waiter hears about changes only. */
  const statesWritten = new Map<string, string>()
  let publishedRequests = ""

  /** Ends a request: its waiter gets `result`, and nothing about it is kept. */
  const settle = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, id: string, result?: string) => {
    openRequests.delete(id)
    saveRequests()
    statesWritten.delete(id)
    await host.mailboxState?.(id, "").catch(() => {})
    if (result !== undefined) await host.mailboxResult?.(id, result).catch(() => {})
  }

  /** How deep sessions may start sessions; `ade.mailbox.maxDepth` in localStorage overrides it. */
  const maxDepth = () => {
    const stored = Number(readStored("ade.mailbox.maxDepth"))
    return Number.isInteger(stored) && stored > 0 ? stored : DEFAULT_MAX_DEPTH
  }
  const parentOf = (paneId: string) => spawnedBy.get(paneId)

  /**
   * Why a session's worktree cannot be thrown away yet, or nothing.
   *
   * What firstmate learned the hard way: a worker is torn down when its work
   * has landed, not when it says it is done. Uncommitted changes, or commits
   * on its branch the project's branch does not have, are work that closing
   * would strand.
   */
  const unintegrated = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, paneId: string): Promise<string | undefined> => {
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    if (!pane?.worktree || !host.run) return undefined
    const status = await host.run("git", ["status", "--porcelain"], pane.worktree)
    if (status.code === 0 && status.stdout.trim()) return `"${pane.title}" ha modifiche non committate in ${pane.worktree}`
    const branch = pane.tree?.branch
    const root = (await projectOfPane(host, paneId))?.root
    if (branch && root) {
      const merged = await host.run("git", ["branch", "--list", branch, "--merged"], root)
      if (merged.code === 0 && !merged.stdout.trim()) return `"${pane.title}" ha commit sul branch ${branch} non ancora integrati`
    }
    return undefined
  }

  /**
   * Closes a spawned session and every session below it, or says why not.
   *
   * Refused when any of them has work not yet integrated, unless forced. A
   * worktree whose work is integrated is removed; one closed by force stays on
   * disk with its branch, because closing a session must never delete work.
   */
  const closeTree = async (
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
    paneId: string,
    force: boolean,
  ): Promise<{ closed: string[]; kept: string[] } | { error: string }> => {
    const ids = [...descendants(paneId, spawnedBy), paneId].filter((id) => wb().panes.some((pane) => pane.id === id))
    const blocked = new Map<string, string>()
    for (const id of ids) {
      const reason = await unintegrated(host, id)
      if (reason) blocked.set(id, reason)
    }
    if (blocked.size > 0 && !force) {
      return { error: `non chiudo: ${[...blocked.values()].join("; ")}. Integra o committa prima, oppure usa --force (la worktree resta su disco)` }
    }
    const closed: string[] = []
    const kept: string[] = []
    for (const id of ids) {
      const pane = wb().panes.find((candidate) => candidate.id === id)
      if (!pane) continue
      for (const request of [...openRequests.values()]) {
        if (request.to === id) await settle(host, request.id, `[ade-msg] richiesta ${request.id} interrotta: la sessione "${pane.title}" è stata chiusa`)
      }
      spawnedBy.delete(id)
      close(id)
      closed.push(pane.title)
      if (pane.worktree) {
        const root = (await projectOfPane(host, id))?.root
        if (!blocked.has(id) && root && host.run) {
          const removed = await host.run("git", ["worktree", "remove", pane.worktree], root)
          if (removed.code !== 0) kept.push(pane.worktree)
        } else {
          kept.push(pane.worktree)
        }
      }
    }
    saveSpawned()
    return { closed, kept }
  }

  /** Makes sure `.ade/` (where subagents put long results) is ignored by git in this project. */
  const excludeAdeResults = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, root: string) => {
    if (!host.run || !host.readTextFile || !host.writeTextFile) return
    const common = await host.run("git", ["rev-parse", "--git-common-dir"], root)
    if (common.code !== 0) return
    const dir = common.stdout.trim()
    const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(dir) ? dir : `${root}/${dir}`
    const file = `${absolute}/info/exclude`
    const current = await host.readTextFile(file).then((read) => read.text).catch(() => "")
    const next = excludeWithAde(current)
    if (next !== undefined) await host.writeTextFile(file, next).catch(() => null)
  }

  const deliverPending = async () => {
    const host = await getHost()
    if (!host?.mailboxTake || !host.mailboxReceipt) return
    for (const { id, body } of await host.mailboxTake().catch(() => [])) {
      const parsed = parseMessage(body)
      const message = parsed && verifySender(parsed, (paneId) => (running.has(paneId) ? paneTokens.get(paneId) : undefined))
      if (message) mailQueue.push({ id, message, at: Date.now() })
      else await host.mailboxReceipt(id, "errore: messaggio non valido").catch(() => {})
    }

    for (const item of [...mailQueue]) {
      const done = await deliverOne(host, item.id, item.message)
      if (done) mailQueue.splice(mailQueue.indexOf(item), 1)
    }

    await readActivities(host)
    const now = Date.now()
    const panes = mailPanes()
    for (const request of [...openRequests.values()]) {
      const state = stateOf(request, now)
      // A request whose answerer is gone will never be answered; the caller is told, not left waiting.
      if (state === "sessione chiusa") {
        const title = wb().panes.find((pane) => pane.id === request.to)?.title ?? request.to
        await settle(host, request.id, `[ade-msg] errore: la sessione "${title}" si è chiusa senza rispondere alla richiesta ${request.id}`)
        continue
      }
      if (statesWritten.get(request.id) !== state) {
        statesWritten.set(request.id, state)
        await host.mailboxState?.(request.id, state).catch(() => {})
      }
      const session = running.get(request.to)
      // Typed, and no turn began: the line is sitting in the input box. One more Enter sends it.
      if (session && shouldRering(request, targetOf(request), now)) {
        request.rings = (request.rings ?? 0) + 1
        saveRequests()
        session.write("\r")
        appendLine(request.to, `Invio ripetuto: la richiesta ${request.id} non era partita`, "note")
        continue
      }
      // Finished, gone quiet, and never replied: reminded, so the caller is not left to its timeout.
      if (session && shouldNudge(request, targetOf(request), now)) {
        request.nudges = (request.nudges ?? 0) + 1
        request.nudgedAt = now
        saveRequests()
        void typeLine(session, formatNudge(request.id, panes.find((pane) => pane.id === request.from)))
        appendLine(request.to, `Promemoria inviato: la richiesta ${request.id} aspetta una risposta`, "note")
      }
    }

    const table = requestsTable([...openRequests.values()], panes, (request) => stateOf(request, now), now)
    if (table !== publishedRequests) {
      publishedRequests = table
      await host.mailboxPublish?.(table, "requests").catch(() => {})
    }
  }

  /** Delivers one message; false leaves it queued for the next pass. */
  const deliverOne = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, id: string, message: Message): Promise<boolean> => {
    const answer = (text: string) => host.mailboxReceipt!(id, text).catch(() => {})
    const panes = mailPanes()
    const sender = panes.find((pane) => pane.id === message.from)

    if (message.kind === "reply") {
      const request = openRequests.get(message.ref)
      if (request && request.to !== message.from) {
        await answer(`errore: la richiesta ${message.ref} non è stata fatta a questa sessione`)
        return true
      }
      if (!host.mailboxResult) {
        await answer("errore: questa versione di ADE non accetta risposte")
        return true
      }
      await settle(host, message.ref, message.text)
      const caller = request ? panes.find((pane) => pane.id === request.from) : undefined
      if (sender) appendLine(sender.id, `Risposta inviata${caller ? ` a ${caller.title}` : ""} (richiesta ${message.ref})`, "note")
      if (caller) appendLine(caller.id, `Risposta ricevuta da ${sender?.title ?? "una sessione"}: ${message.text}`, "note")
      await answer(
        `ok: risposta consegnata${caller ? ` a "${caller.title}"` : ""}` +
          (request?.autoClose ? " — se non ha lavoro da integrare questa sessione ora si chiude" : " — la sessione resta aperta per i seguiti"),
      )
      // Nobody claimed it: the caller stopped waiting, so it is typed in, the way a background subagent reports back.
      setTimeout(() => {
        void host.mailboxResultReclaim?.(message.ref).then((text) => {
          const session = caller && running.get(caller.id)
          if (text == null || !session || permissions()[caller.id]) return
          void typeLine(session, formatLateReply(message.ref, text, sender))
        })
      }, CLAIM_WINDOW_MS)
      if (request?.autoClose) {
        setTimeout(() => {
          void closeTree(host, request.to, false).then((outcome) => {
            const note = "error" in outcome ? `Resta aperta: ${outcome.error}` : `Chiusa dopo la risposta: ${outcome.closed.join(", ")}`
            appendLine(request.to, note, "note")
            if (caller) appendLine(caller.id, note, "note")
          })
        }, AUTO_CLOSE_DELAY_MS)
      }
      return true
    }

    if (message.kind === "update") {
      const request = openRequests.get(message.ref)
      if (!request) {
        await answer(`errore: nessuna richiesta aperta con id ${message.ref}`)
        return true
      }
      if (request.to !== message.from) {
        await answer(`errore: la richiesta ${message.ref} non è stata fatta a questa sessione`)
        return true
      }
      request.update = { state: message.state, text: message.text, at: Date.now() }
      saveRequests()
      const caller = panes.find((pane) => pane.id === request.from)
      const line = formatUpdate(request.id, message.state, message.text, sender)
      await host.mailboxState?.(request.id, line, "update").catch(() => {})
      if (caller) appendLine(caller.id, `Aggiornamento da ${sender?.title ?? "una sessione"}: ${message.state} — ${message.text}`, "note")
      await answer(`ok: aggiornamento consegnato${caller ? ` a "${caller.title}"` : ""}; la richiesta resta aperta, aspetta la sua risposta`)
      // Nobody woke on it: typed into the caller, which is not waiting any more.
      setTimeout(() => {
        void host.mailboxResultReclaim?.(request.id, "update").then((text) => {
          const session = caller && running.get(caller.id)
          if (text == null || !session || permissions()[caller.id]) return
          void typeLine(session, text)
        })
      }, CLAIM_WINDOW_MS)
      return true
    }

    if (message.kind === "cancel") {
      const request = openRequests.get(message.ref)
      if (!request) {
        await answer(`errore: nessuna richiesta aperta con id ${message.ref}`)
        return true
      }
      if (!message.from || request.from !== message.from) {
        await answer("errore: puoi annullare solo le richieste fatte da questa sessione")
        return true
      }
      await settle(host, request.id, `[ade-msg] richiesta ${request.id} annullata`)
      // The session stays: it may have other work, and closing is `ade-msg close`'s decision.
      const session = running.get(request.to)
      if (session && !permissions()[request.to]) void typeLine(session, formatCancel(request.id, sender))
      await answer(`ok: richiesta ${request.id} annullata; la sessione resta aperta (chiudila con ade-msg close se non serve più)`)
      return true
    }

    if (message.kind === "kv") {
      const space = sender?.project || project()?.name || "workspace"
      const result = applyKv(
        kvStore[space] ?? emptySpace(),
        { op: message.op, key: message.key, value: message.text, ttl: message.ttl, force: message.force },
        sender ? { id: sender.id, title: sender.title } : undefined,
        Date.now(),
        (paneId) => running.has(paneId),
      )
      if (result.space !== kvStore[space]) {
        kvStore = { ...kvStore, [space]: result.space }
        saveKv()
      }
      await answer(result.reply)
      return true
    }

    if (message.kind === "memory") {
      const owner = message.from ? await projectOfPane(host, message.from) : project()
      if (!owner || owner.remote) {
        await answer("errore: la memoria condivisa esiste solo per i progetti locali")
        return true
      }
      const path = `${owner.root}/.ade/memory.md`
      const current = host.readTextFile ? await host.readTextFile(path).then((read) => read.text).catch(() => "") : ""
      if (message.op === "show") {
        await answer(current.trim() ? `ok\n${current}` : `ok\n(memoria vuota: ${path})`)
        return true
      }
      if (!sender) {
        await answer("errore: scrivere in memoria richiede una sessione avviata da ADE")
        return true
      }
      const entry = memoryEntry(message.type, message.text, sender.title, new Date())
      if ("error" in entry) {
        await answer(`errore: ${entry.error}`)
        return true
      }
      const next = withMemoryEntry(current, entry.line)
      const failure = host.writeTextFile ? await host.writeTextFile(path, next) : "scrittura non disponibile"
      if (failure) {
        await answer(`errore: ${failure}`)
        return true
      }
      await excludeAdeResults(host, owner.root)
      appendLine(sender.id, `Memoria: ${entry.line.trim()}`, "note")
      await answer(memoryAddReply(path, next.length))
      return true
    }

    if (message.kind === "spawn") {
      const agent = resolveAgent(SPAWNABLE, message.agent)
      if ("error" in agent) {
        await answer(`errore: ${agent.error}`)
        return true
      }
      /*
       * A fork starts from the sender's own conversation: same CLI, same model,
       * same directory — the three things the prompt cache and the CLI's own
       * lookup of the conversation depend on.
       */
      let fork: { args: string[]; resumeId?: string } | undefined
      if (message.fork) {
        const parent = wb().panes.find((pane) => pane.id === message.from)
        const parentAgent = parent?.agent ?? parent?.model
        const refusal = !parent
          ? "--fork richiede una sessione avviata da ADE"
          : parentAgent !== agent.id
            ? `--fork parte dalla tua conversazione, quindi l'agente deve essere il tuo (${parentAgent})`
            : message.model
              ? "--fork usa il tuo modello: toglilo --model, un modello diverso non riusa la cache"
              : message.worktree
                ? "--fork e --worktree insieme non sono supportati: la conversazione è legata alla cartella"
                : parent.cwd && isRemoteRoot(parent.cwd)
                  ? "--fork non è disponibile negli ambienti remoti"
                  : undefined
        if (refusal) {
          await answer(`errore: ${refusal}`)
          return true
        }
        const planned = planFork(agent.id, parent!.resumeId)
        if ("error" in planned) {
          await answer(`errore: ${planned.error}`)
          return true
        }
        fork = planned
      }
      const open = [...spawnedBy.keys()].filter((paneId) => wb().panes.some((pane) => pane.id === paneId))
      if (open.length >= maxSpawned()) {
        await answer(
          `errore: ci sono già ${open.length} sessioni avviate con spawn (limite ${maxSpawned()}); chiudine una con ade-msg close <sessione> o aspetta che finiscano`,
        )
        return true
      }
      // Depth: the user's own sessions are level 0, and each spawn goes one down.
      const depth = message.from ? depthOf(message.from, parentOf) + 1 : 1
      if (depth > maxDepth()) {
        await answer(`errore: questa sessione è già al livello ${depth - 1} e il massimo è ${maxDepth()}: fai il lavoro qui o chiedi a chi ti ha avviato`)
        return true
      }

      let name: string | undefined
      if (message.name !== undefined) {
        const checked = checkName(message.name)
        if ("error" in checked) {
          await answer(`errore: ${checked.error}`)
          return true
        }
        if (nameTaken(panes.map((pane) => pane.title), checked.name)) {
          await answer(`errore: esiste già una sessione "${checked.name}": scegli un altro nome, o mandale una richiesta con ade-msg ask`)
          return true
        }
        name = checked.name
      }

      // A fork keeps the parent's model choice: a different model is a different cache.
      const spawnArgs: string[] = fork ? [...(wb().panes.find((pane) => pane.id === message.from)?.spawnArgs ?? [])] : []
      if (message.model) {
        const chosen = modelArgs(agent.id, message.model)
        if ("error" in chosen) {
          await answer(`errore: ${chosen.error}`)
          return true
        }
        spawnArgs.push(...chosen)
      }

      // A subagent works in its caller's project, whichever one is open in ADE.
      const owner = sender?.project || project()?.name
      const ownerProject = message.from ? await projectOfPane(host, message.from) : project()
      const root = ownerProject?.root
      let worktree: { path: string; branch: string } | undefined
      if (message.worktree) {
        if (!root || !host.run) {
          await answer("errore: nessun progetto in cui creare la worktree")
          return true
        }
        const plan = worktreePlan(root, slugify(name ?? `${agent.id}-${id.slice(-8)}`))
        const added = await host.run("git", ["worktree", "add", "-b", plan.branch, plan.path], root)
        if (added.code !== 0) {
          await answer(`errore: worktree non creata (${(added.stderr || added.stdout).trim().split(/\r?\n/)[0] || "git ha rifiutato"})`)
          return true
        }
        worktree = plan
        spawnArgs.push(...worktreeArgs(agent.id, plan.path))
      }
      if (root) await excludeAdeResults(host, root)

      const title = name ?? `${agentLabel(agent.id)} ← ${sender?.title ?? "ade-msg"}: ${briefOf(message.text, 48)}`
      const index = (owner ? wb().panes.filter((pane) => pane.workspaceId === owner) : wb().panes).length + 1
      const task = formatRequest(id, message.text, sender, {
        ...(worktree ? { worktree } : {}),
        ...(worktree || root ? { resultsDir: resultsDir(worktree?.path ?? root!) } : {}),
        depth,
        maxDepth: maxDepth(),
      })
      const created = addAgent(
        { agentId: agent.id, count: 1, task, title, workspaceId: owner, ...(worktree ? { worktree } : {}), spawnArgs, ...(fork ? { fork } : {}) },
        { index, agentId: agent.id, role: "agent" },
      )
      openRequests.set(id, {
        id,
        kind: "spawn",
        from: message.from,
        to: created.id,
        at: Date.now(),
        brief: briefOf(message.text),
        ...(message.autoClose ? { autoClose: true } : {}),
      })
      saveRequests()
      if (message.from) {
        spawnedBy.set(created.id, message.from)
        saveSpawned()
      }
      if (sender) appendLine(sender.id, `Subagent avviato: ${created.title}`, "note")
      await answer(
        `ok: avviata la sessione "${created.title}" (${agent.id}, id ${created.id}, livello ${depth})` +
          (worktree ? ` nella worktree ${worktree.path} sul branch ${worktree.branch}` : "") +
          (fork ? " come fork della tua conversazione" : ""),
      )
      return true
    }

    const target = resolveTarget(panes, message.to, message.from)
    if ("error" in target) {
      await answer(`errore: ${target.error}`)
      return true
    }

    if (message.kind === "relaunch") {
      if (!message.from || spawnedBy.get(target.pane.id) !== message.from) {
        await answer(`errore: puoi riavviare solo le sessioni avviate da questa sessione con spawn ("${target.pane.title}" non lo è)`)
        return true
      }
      const pane = wb().panes.find((candidate) => candidate.id === target.pane.id)
      if (!pane) {
        await answer(`errore: la sessione "${target.pane.title}" non esiste più`)
        return true
      }
      const agentId = pane.agent ?? pane.model
      let spawnArgs = pane.spawnArgs ?? []
      if (message.model) {
        const chosen = modelArgs(agentId, message.model)
        if ("error" in chosen) {
          await answer(`errore: ${chosen.error}`)
          return true
        }
        spawnArgs = [...withoutModel(spawnArgs), ...chosen]
      }
      /*
       * Same pane, same worktree, same place in the tree. The old process goes
       * first; its exit is ignored because `running` already holds nothing for
       * the pane, and then the new spawn's.
       */
      const old = running.get(pane.id)
      running.delete(pane.id)
      touchRunning()
      old?.kill()
      setWb((w) => updatePane(w, pane.id, { spawnArgs, ...(message.fresh ? { resumeId: undefined } : {}) }))
      if (message.fresh) {
        for (const request of [...openRequests.values()]) {
          if (request.to === pane.id) {
            await settle(host, request.id, `[ade-msg] richiesta ${request.id} interrotta: la sessione "${pane.title}" è stata riavviata da zero`)
          }
        }
        void startProcess(pane.id, agentId, "")
      } else {
        const updated = wb().panes.find((candidate) => candidate.id === pane.id)
        if (updated) void reopen(updated)
      }
      appendLine(pane.id, `Riavviata da ${sender?.title ?? "una sessione"}${message.model ? ` con il modello ${message.model}` : ""}${message.fresh ? ", da zero" : ""}`, "note")
      await answer(
        `ok: riavviata "${pane.title}"${message.model ? ` con ${message.model}` : ""}` +
          (message.fresh ? " da zero: mandale il compito con ade-msg ask" : "; riprende la sua conversazione e le richieste aperte restano valide"),
      )
      return true
    }

    if (message.kind === "close") {
      if (!message.from || spawnedBy.get(target.pane.id) !== message.from) {
        await answer(`errore: puoi chiudere solo le sessioni avviate da questa sessione con spawn ("${target.pane.title}" non lo è)`)
        return true
      }
      const outcome = await closeTree(host, target.pane.id, message.force)
      if ("error" in outcome) {
        await answer(`errore: ${outcome.error}`)
        return true
      }
      await answer(
        `ok: chiuse ${outcome.closed.map((title) => `"${title}"`).join(", ")}` +
          (outcome.kept.length ? `; worktree lasciate su disco: ${outcome.kept.join(", ")}` : ""),
      )
      return true
    }

    if (message.kind === "ask" && target.pane.id === message.from) {
      await answer("errore: una sessione non può fare una richiesta a se stessa")
      return true
    }
    const session = running.get(target.pane.id)
    if (!session) {
      await answer(`errore: la sessione "${target.pane.title}" non è attiva`)
      return true
    }
    // A standing permission prompt reads the next Enter as its answer: the message waits for it to go.
    if (permissions()[target.pane.id]) return false

    const targetPane = wb().panes.find((pane) => pane.id === target.pane.id)
    const targetDepth = depthOf(target.pane.id, parentOf)
    const line =
      message.kind === "ask"
        ? formatRequest(id, message.text, sender, {
            ...(targetPane?.cwd ? { resultsDir: resultsDir(targetPane.cwd) } : {}),
            depth: targetDepth,
            maxDepth: maxDepth(),
          })
        : formatDelivery(message, sender)
    if (!(await typeLine(session, line))) {
      await answer(`errore: la sessione "${target.pane.title}" si è chiusa durante la consegna`)
      return true
    }
    // The caller has spoken to a session that said it was blocked on it: that is the answer it was waiting for.
    for (const request of openRequests.values()) {
      if (request.update && request.from === message.from && request.to === target.pane.id) {
        delete request.update
        saveRequests()
      }
    }
    if (message.kind === "ask") {
      const at = Date.now()
      openRequests.set(id, { id, kind: "ask", from: message.from, to: target.pane.id, at, deliveredAt: at, brief: briefOf(message.text) })
      saveRequests()
    }
    const what = message.kind === "ask" ? "Richiesta" : "Messaggio"
    appendLine(target.pane.id, `${what} ricevuto da ${sender?.title ?? "una sessione"}: ${message.text}`, "note")
    if (sender) appendLine(sender.id, `${what} inviato a ${target.pane.title}: ${message.text}`, "note")
    await answer(`ok: consegnato a ${panes.indexOf(target.pane) + 1} "${target.pane.title}"`)
    return true
  }

  /*
   * New releases reach the bell by themselves: a published `ade-v*` release
   * on the fork is announced once, with a button that installs it. Desktop only,
   * since a browser tab of the dev server has no installed version to be behind.
   */
  onMount(() => {
    if (!isTauriDesktop()) return
    const stop = startUpdateWatch({
      currentVersion: async () => (await import("@tauri-apps/api/app")).getVersion(),
      onUpdate: (update) =>
        setNotices((list) =>
          addNotice(list, {
            kind: "info",
            text: `ADE ${update.version} è disponibile`,
            href: update.url,
            at: Date.now(),
          }),
        ),
    })
    onCleanup(stop)
  })

  const openNoticeLink = async (href: string) => {
    if (!isReleasePage(href)) return
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("ade_open_release", { url: href })
    } catch (error) {
      report(`Impossibile aprire la pagina: ${String(error)}`)
    }
  }

  /*
   * A release notice installs the release: download, install, restart, all
   * inside ADE. The restart stops every running agent; the workspace is
   * written first, and not left to the autosave's debounce, because the
   * installer ends this process without a `pagehide` — and that saved state is
   * what brings the sessions back, resumed by conversation id, on the next
   * start. Asked first when there is something running. A platform the manifest does not cover (a .deb
   * or .rpm install, Linux on ARM) or a failed download falls back to the
   * release page, so the notice is never a dead end.
   */
  const [updating, setUpdating] = createSignal(false)
  const installUpdate = async (href: string) => {
    if (updating()) return
    const running = wb().panes.filter(
      (pane) =>
        !pane.browserUrl && !pane.filePath && !pane.videoPath && !pane.plugin && (pane.agent ?? pane.model) &&
        pane.status !== "done" && pane.status !== "error",
    ).length
    if (running > 0) {
      const { ask } = await import("@tauri-apps/plugin-dialog")
      const go = await ask(
        `ADE si riavvia per aggiornarsi: ${running === 1 ? "la sessione in corso viene interrotta e ripresa" : `le ${running} sessioni in corso vengono interrotte e riprese`} alla riapertura.`,
        { title: "Aggiorna ADE", kind: "warning", okLabel: "Aggiorna e riavvia", cancelLabel: "Più tardi" },
      )
      if (!go) return
    }
    setUpdating(true)
    autosave.flush()
    // localStorage reaches WebView2's disk store a moment after setItem.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("ade_update_install")
    } catch (error) {
      setUpdating(false)
      report(`Aggiornamento non riuscito (${String(error)}): apro la pagina della release.`)
      await openNoticeLink(href)
    }
  }

  onMount(() => {
    /*
     * Mail has to keep moving while ADE is minimised — agents message each
     * other whether or not anyone is watching — but a hidden window can wait
     * longer, and with no session running a pass every three seconds is
     * plenty for a request arriving from outside.
     */
    let mailPass = 0
    onCleanup(
      every(
        700,
        () => {
          mailPass++
          if (running.size === 0 && mailPass % 4 !== 0) return
          return deliverMail()
        },
        { whenHidden: 2_000 },
      ),
    )
    // Usage only feeds what is on screen and `ade-msg stats`: paused while hidden.
    onCleanup(every(15_000, () => refreshUsage()))
    void getHost().then((host) => {
      void host?.mailboxPublish?.(agentsTable(SPAWNABLE), "agents").catch(() => {})
      void host?.mailboxPublish?.(USAGE, "usage").catch(() => {})
    })
  })

  // The list `ade-msg list` prints, rewritten when a session opens, closes or changes state.
  createEffect(() => {
    runningTick()
    const table = sessionsTable(mailPanes())
    void getHost().then((host) => host?.mailboxPublish?.(table, "sessions").catch(() => {}))
  })

  /*
   * What voice needs is a microphone, and nothing more.
   *
   * This used to ask for the browser's SpeechRecognition, which inside the
   * webview ADE ships in is a constructor with no service behind it: it
   * answered every start with an immediate end, no audio and no error. Both
   * engines that remain — the local model and the cloud one — read the
   * microphone themselves, so mediaDevices is the whole requirement.
   */
  const voiceAvailable =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia
  const rawSavedVoice = typeof localStorage !== "undefined" ? localStorage.getItem("voice.settings") : null
  const initialVoice = loadVoiceSettings()
  const [voiceSettings, setVoiceSettings] = createSignal<VoiceSettings>(initialVoice.settings)
  const [voiceSettingsOpen, setVoiceSettingsOpen] = createSignal(false)

  /*
   * Which CLIs are set up to report their own session id.
   *
   * Read once at start and again after the settings panel changes one, rather
   * than asked per spawn: it is two file reads, it almost never changes, and
   * `startProcess` is already the slowest thing the user waits on.
   */
  const [hookStates, setHookStates] = createSignal<Record<string, HookStatus>>({})
  /* The host, kept for the settings panel, which renders synchronously. */
  const [hookHost, setHookHost] = createSignal<HookHost>({})
  const refreshHooks = async () => {
    const host = await getHost()
    if (!host) return
    setHookHost(() => host)
    const states = await Promise.all(HOOK_TARGETS.map((target) => readHookStatus(host, target)))
    setHookStates(Object.fromEntries(states.map((state) => [state.target.id, state])))
    // An install from an older ADE gets this version's script.
    for (const state of states) {
      if (!state.installed) continue
      const key = `ade.hookScript.${state.target.id}`
      let last: string | undefined
      try {
        last = localStorage.getItem(key) ?? undefined
      } catch {}
      const written = await refreshHookScript(host, state.target, last).catch(() => undefined)
      if (written) {
        try {
          localStorage.setItem(key, written)
        } catch {}
      }
    }
  }

  /*
   * A saved voice chord that ADE also claims resolves to ADE and opens no
   * microphone, and there is nothing on screen to say so — the user presses
   * the shortcut they configured and gets a pane command or nothing at all.
   * The panel says it too, but only once opened; this says it on the way in.
   */
  const shadowedVoiceChords = summarizeVoiceShortcutConflicts(
    initialVoice.settings,
    bindings,
    platform
  )
  const [voiceNotice, setVoiceNotice] = createSignal<string | undefined>(
    [
      initialVoice.corrections.filter((c) => !c.includes("assenti")).length > 0
        ? initialVoice.corrections.filter((c) => !c.includes("assenti")).join(" ")
        : rawSavedVoice !== null && initialVoice.corrections.length > 0
          ? initialVoice.corrections.join(" ")
          : undefined,
      shadowedVoiceChords,
    ]
      .filter((line): line is string => line !== undefined)
      .join(" ") || undefined
  )

  /*
   * Which of the catalogue this machine can actually start.
   *
   * The new-session form probes for itself when it opens, and voice cannot
   * wait for a form nobody opened: told "avvia una sessione codex" it has to
   * know now whether codex exists here. `probe` is a PATH lookup rather than a
   * run (see `host.probe`), so asking at mount costs a dozen lookups and wakes
   * nothing. While it is still unanswered the voice host reports every agent
   * as available — see `listAgents` for why that, and not "assente".
   */
  const [agentStatuses] = createResource(async () =>
    // Caught here: a resource read outside a Suspense boundary rethrows its
    // failure, and losing the catalogue is not worth breaking `listAgents`.
    detectAgents((await getHost())?.probe).catch(() => undefined),
  )

  const voiceHost = createAdeVoiceHost({
    wb,
    setWb,
    project,
    runCommand: (id) => runCommand(id),
    isRunning,
    getRunningSession: (id) => running.get(id),
    openFile: (path) => openFile(path),
    appendLine: (id, text, kind) => appendLine(id, text, kind),
    permissions,
    answerPermission: (id, ans) => answerPermission(id, ans),
    getHost,
    recents,
    agentAvailability: () => agentStatuses(),
    switchProject: (root) => switchProjectTo(root),
    openAgentSession: (input) => openVoiceSession(input),
  })

  /*
   * No transcriber is built here on purpose. The engine builds one from the
   * chosen backend every time it starts, so switching between the local model
   * and the cloud engine in the settings panel takes effect on the next press
   * instead of after a reload — which is what a single instance pinned at
   * mount cost us before.
   */
  const noMicrophone = {
    start: async () => {
      throw new Error("Nessun microfono disponibile in questo ambiente.")
    },
    stop: async () => {},
    onPartial: () => {},
    onFinal: () => {},
    onError: () => {},
  }
  const speaker =
    typeof window !== "undefined" && "speechSynthesis" in window
      ? createWebSpeechSpeaker({ lang: "it-IT" })
      : createFakeSpeaker()

  /*
   * The level meter drives the mic ring and the settings panel's waveform, and
   * nothing else. A second getUserMedia stream is the one part of starting up
   * that can fail on its own — a headless webview, a denied prompt — so its
   * failure is swallowed here: losing the animation must never cost the user
   * the ability to speak.
   */
  const rawMicMeter = voiceAvailable ? createMicMeter() : undefined
  const micMeter = rawMicMeter
    ? {
        start: async () => {
          try {
            await rawMicMeter.start()
          } catch {
            // level display only; recognition runs on its own stream
          }
        },
        onLevel: (cb: (level: number) => void) => rawMicMeter.onLevel(cb),
        // Passed through: the engine tells the meter which microphone to open
        // so the ring animates off the same device recognition is reading.
        setDevice: (deviceId: string | undefined) => rawMicMeter.setDevice(deviceId),
        stop: () => rawMicMeter.stop(),
        get isRunning() {
          return rawMicMeter.isRunning
        },
      }
    : undefined

  const voiceEngine = createVoiceEngine({
    host: voiceHost,
    settings: voiceSettings(),
    ...(voiceAvailable ? {} : { transcriber: noMicrophone }),
    speaker,
    micMeter,
    now: () => Date.now(),
    getContext: () => ({
      focusedPaneId: wb().focusedId,
    }),
  })

  /* Set once the native shell has registered the voice hotkeys; see onMount. */
  let registerGlobalShortcuts: ((settings: VoiceSettings) => Promise<void>) | undefined

  const handleVoiceSettingsChange = async (next: VoiceSettings) => {
    const saved = saveVoiceSettings(next)
    setVoiceSettings(saved.settings)
    await voiceEngine.updateSettings(saved.settings)
    await registerGlobalShortcuts?.(saved.settings)
  }

  const pttHandler = createPushToTalkHandler(voiceEngine)

  onCleanup(() => {
    void voiceEngine.stop()
  })

  /*
   * Plugins.
   *
   * Built here rather than in a provider because everything the runtime needs
   * is already a local of this function — the workbench signal, the project,
   * the palette — and a context would only be a way to reach them from
   * further away. `packages/ade/src/plugin/` holds the machinery; what is
   * wired here is the four places a plugin can reach ADE.
   */
  const pluginIO: DiscoveryIO = {
    async readTextFile(path, maxBytes) {
      const host = await getHost()
      if (!host?.readTextFile) throw new Error("nessun host desktop")
      return host.readTextFile(path, maxBytes)
    },
    async exists(path) {
      const host = await getHost()
      return (await host?.exists?.(path)) ?? false
    },
  }

  const pluginRuntime = createAdePluginRuntime({
    io: pluginIO,
    load: importPluginModule,
    internal: ({ status, registry }) => [createManagerPlugin(status, registry)],
    async trust(root, plugins) {
      let stored: string | null = null
      try {
        stored = localStorage.getItem(CONSENT_KEY)
      } catch {
        // No storage: ask every time.
      }
      if (hasConsent(stored, root, plugins)) return true
      const { ask } = await import("@tauri-apps/plugin-dialog")
      const allowed = await ask(consentQuestion(root, plugins), {
        title: "Plugin del progetto",
        kind: "warning",
        okLabel: "Esegui",
        cancelLabel: "Non ora",
      })
      if (allowed) {
        try {
          localStorage.setItem(CONSENT_KEY, withConsent(stored, root, plugins))
        } catch {
          // Approved for this start only.
        }
      }
      return allowed
    },
    host: {
      data: {
        project: () => {
          const current = project()
          if (!current) return undefined
          return { name: current.name, root: current.root, branch: current.branch }
        },
        session: {
          list: () => wb().panes.filter((pane) => !pane.browserUrl && !pane.plugin).map(toPluginSession),
          get: (id) => {
            const pane = wb().panes.find((item) => item.id === id)
            return pane && !pane.browserUrl && !pane.plugin ? toPluginSession(pane) : undefined
          },
          focused: () => {
            const pane = wb().panes.find((item) => item.id === wb().focusedId)
            return pane && !pane.browserUrl && !pane.plugin ? toPluginSession(pane) : undefined
          },
        },
      },
      showPalette: () => setPaletteOpen(true),
      onPaneOpened: (pane) => {
        setWb((w) =>
          addPane(w, {
            id: pane.id,
            title: pane.title,
            // A plugin tile has no process, so the only honest status is the
            // one that draws no liveness sweep.
            status: "done",
            model: "—",
            mode: "plugin",
            workspaceId: project()?.name ?? "workspace",
            lines: [],
            plugin: { pluginId: pane.pluginId, name: pane.name },
          }),
        )
      },
      onPaneClosed: (paneId) => setWb((w) => closePane(w, paneId)),
    },
  })

  /*
   * Reloaded when the project changes, because what is declared is the
   * project's business: `.nikcli/tui.json` belongs to the checkout, and the
   * plugins of the project you just left have no reason to keep a section in
   * the sidebar of the one you just opened.
   */
  createEffect(
    on(
      () => project()?.root,
      (root) => {
        void pluginRuntime.start(root)
      },
    ),
  )

  // Synchronously, at the top level of the component: an `onCleanup` after an
  // await has a null owner and is a silent no-op.
  onCleanup(() => {
    void pluginRuntime.dispose()
  })

  // Load recents and workspace on mount
  onMount(async () => {
    const startedAt = Date.now()
    const host = await getHost()
    setHasHost(!!host)

    /*
     * Not awaited: it decides whether a spawn passes a nonce, and the panes
     * restored below take seconds to start. Holding the splash on two file
     * reads to win the id of a session that is not running yet is the wrong
     * trade — a session started before the answer arrives simply resumes the
     * way it did before the hook existed.
     */
    void refreshHooks()

    // Load recents
    const savedRecents = localStorage.getItem("ade.recents")
    if (savedRecents) {
      setRecents(parseRecents(savedRecents))
    }

    themeState.restore()
    setBooting("ripristino le sessioni")

    // Load workspace
    const savedWs = localStorage.getItem("ade.workspace")
    let restored: WorkspaceState | undefined
    if (savedWs) {
      const state = parseWorkspace(savedWs)
      if (state) {
        restored = state
        setWb(fromWorkspaceState(state))
      }
    }

    // Discover project
    if (host) {
      setBooting("apro il progetto")
      const path = restored?.projectPath || (host.currentDir ? await host.currentDir() : "")
      const p = await discoverProject(host, path)
      setProject(p)

      const newRecents = addRecent(recents(), { root: p.root, name: p.name })
      setRecents(newRecents)
      localStorage.setItem("ade.recents", serializeRecents(newRecents))

      setWb(w => ({ ...w, projectPath: p.root }))

      /*
       * Restarting what was running when the app went away.
       *
       * A pty is a child of this process: closing the window kills it, and a
       * machine restart kills everything, so no session literally survives.
       * What can survive is the session's identity — its agent, its directory
       * and the task it was given — and starting that work again on open is
       * what "the sessions come back" can actually mean.
       *
       * Only after the project resolves, because `startProcess` needs it to
       * choose a working directory, and only for sessions that were live and
       * carry a task: a finished one has nothing to resume, and a task-less
       * one would launch an agent with an empty prompt.
       */
      if (restored) {
        /*
         * Planned all at once, not one at a time.
         *
         * The CLIs that cannot be asked for a specific conversation can only
         * offer "the most recent one in this directory", and two panes both
         * taking that offer reopen the same conversation and then race each
         * other inside it. `planRestore` hands the claim out once.
         */
        /*
         * And checked against the disk first: an id ADE pinned is only a
         * conversation once the agent has written one. Resuming an id that was
         * never used prints "No conversation found" and opens a thread under
         * an id nobody recorded — on every restart, forever. The agent runs in
         * `p.root` (see `startProcess`), so that is where its transcript is.
         */
        const sessions = await Promise.all(
          sessionsToResume(restored).map(async (pane) => ({
            agentId: pane.agent,
            cwd: pane.cwd || p.root,
            ...(pane.resumeId !== undefined ? { resumeId: pane.resumeId } : {}),
            missing: await conversationMissing(pane.agent, pane.resumeId, pane.cwd || p.root),
            pane,
          })),
        )
        for (const { session, plan } of planRestore(sessions)) {
          void startProcess(session.pane.id, session.pane.agent, session.pane.task ?? "", plan)
        }

        /*
         * And the sessions whose agent had already exited, too.
         *
         * They used to wait for a click on "Riprendi", and nobody opens ADE to
         * look at a dead transcript: the pane is there to be used. `reopen`
         * asks for the conversation by id when there is one, and starts the
         * agent fresh when there is not.
         */
        const planned = new Set(sessions.map((session) => session.pane.id))
        for (const pane of wb().panes) {
          if (planned.has(pane.id)) continue
          if (pane.browserUrl || pane.filePath || pane.videoPath || pane.plugin) continue
          if (!(pane.agent ?? pane.model)) continue
          void reopen(pane)
        }
      }
    }

    /*
     * The splash stays up for a moment even when there was nothing to wait
     * for.
     *
     * On a warm start the whole of the above finishes in under a hundred
     * milliseconds, and a screen that appears and vanishes in that time is a
     * flash of something the user cannot read — worse than no splash at all.
     * A floor, not a delay: when the start really does take two seconds the
     * splash goes the moment it is over.
     */
    const remaining = SPLASH_FLOOR_MS - (Date.now() - startedAt)
    if (remaining > 0 && booting() !== undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining)
        skipSplashResolver = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    setBooting(undefined)
  })

  const autosave = createAutosave({
    // The revision and not the store: reading `wb()` subscribes to nothing,
    // because a store is tracked per property and the save cares about all of
    // them.
    changed: revision,
    write: () =>
      // Unwrapped: serialising walks every pane and every line, and doing that
      // through the store's proxy would subscribe whatever happens to be
      // tracking to the entire workbench.
      localStorage.setItem("ade.workspace", serializeWorkspace(toWorkspaceState(unwrap(wbStore)))),
  })

  // Keydown listener
  onMount(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const resolution = resolveVoiceOrAdeKey(bindings, voiceSettings(), e, platform)

      /*
       * Voice shortcuts take absolute precedence everywhere, even inside terminals or text inputs!
       * Intercepted in capture phase with stopPropagation so xterm cannot swallow them.
       */
      if (resolution.type === "voice-agent" || resolution.type === "voice-transcription") {
        e.preventDefault()
        e.stopPropagation()
        const mode = resolution.type === "voice-agent" ? "agent" : "transcription"
        if (voiceSettings().activation === "push-to-talk") {
          const chord = mode === "agent" ? voiceSettings().agentChord : voiceSettings().transcriptionChord
          void pttHandler.onKeyDown(parseChord(chord, platform), e, mode)
        } else {
          if (e.repeat) return
          void voiceEngine.toggle(mode)
        }
        return
      }

      /*
       * Inside a terminal, the terminal gets the key.
       *
       * xterm renders into a textarea, and the guard below let every Ctrl
       * chord through on the grounds that a bare letter in a text field is
       * typing while Ctrl+something is a command. In a terminal it is the
       * other way round: Ctrl+W deletes a word, Ctrl+N walks the history,
       * Ctrl+Shift+V pastes. ADE was taking all three — and Ctrl+W did not
       * just steal a keystroke, it closed the pane and killed the agent
       * running in it. On Windows and Linux, where `mod` is Ctrl, that is a
       * daily occurrence.
       */
      const isTerminal = Boolean(target?.closest?.('[data-slot="pane-terminal"]'))
      if (isTerminal && resolution.type === "ade") return

      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
      if (isInput && !e.ctrlKey && !e.metaKey && !e.altKey) return

      if (resolution.type === "ade") {
        if (resolution.commandId && isHandledCommand(resolution.commandId)) {
          e.preventDefault()
          e.stopPropagation()
          void runCommand(resolution.commandId)
        }
        return
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (pttHandler.isPressed() && pttHandler.shouldReleaseKey(e.key, e.code)) {
        e.preventDefault()
        e.stopPropagation()
        void pttHandler.onKeyUp(e.key, e.code)
      }
    }

    const handleBlur = () => {
      if (pttHandler.isPressed()) {
        void pttHandler.onBlur()
      }
    }

    /*
     * Closing the window is the one way out of ADE that `close` cannot guard.
     * A modified buffer lives only in memory, so quitting with one open loses
     * it as completely as closing its pane would.
     */
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const unsaved = Object.values(buffers()).filter((buffer) => buffer.dirty)
      if (unsaved.length === 0) return
      event.preventDefault()
      // Browsers ignore the text and show their own, but setting returnValue
      // is still what makes the prompt appear at all.
      event.returnValue = ""
    }

    window.addEventListener("keydown", handleKeyDown, true)
    window.addEventListener("keyup", handleKeyUp, true)
    window.addEventListener("blur", handleBlur)
    window.addEventListener("beforeunload", handleBeforeUnload)
    // Auto-sync OpenRouter API key from nikcli auth.json if not present in localStorage
    if (!voiceSettings().openRouterApiKey) {
      void (async () => {
        try {
          const host = await getHost()
          const home = await host?.homeDir?.()
          if (home) {
            const normalizedHome = home.replace(/\\/g, "/")
            const candidatePaths = [
              `${normalizedHome}/AppData/Local/nikcli/auth.json`,
              `${home}/AppData/Local/nikcli/auth.json`,
              `${home}\\AppData\\Local\\nikcli\\auth.json`,
              `${normalizedHome}/AppData/Roaming/nikcli/auth.json`,
              `${home}/AppData/Roaming/nikcli/auth.json`,
              `${home}\\AppData\\Roaming\\nikcli\\auth.json`,
              `${normalizedHome}/.config/nikcli/auth.json`,
              `${normalizedHome}/.nikcli/auth.json`,
            ]
            for (const authPath of candidatePaths) {
              try {
                const file = await host?.readTextFile?.(authPath, 64 * 1024)
                if (file?.text) {
                  const parsed = JSON.parse(file.text)
                  const orKey = parsed?.openrouter?.key
                  if (typeof orKey === "string" && orKey.trim().length > 0) {
                    await handleVoiceSettingsChange({
                      ...voiceSettings(),
                      openRouterApiKey: orKey.trim(),
                    })
                    break
                  }
                }
              } catch {
                // check next path
              }
            }
          }
        } catch {
          // ignore
        }
      })()
    }

    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)) {
      /*
       * The cleanup is registered here, before the first await. It used to be
       * an `onCleanup` at the end of the async block below, where Solid has no
       * owner and the call does nothing: closing the workbench left the global
       * hotkeys registered and the listener alive.
       */
      let disposed = false
      let releaseGlobal: (() => void) | undefined
      onCleanup(() => {
        disposed = true
        releaseGlobal?.()
      })
      void (async () => {
        try {
          const { listen } = await import("@tauri-apps/api/event")
          const { invoke } = await import("@tauri-apps/api/core")

          /*
           * Registered from the settings as they are now, and again whenever
           * they change: the panel used to save a new chord that the OS kept
           * ignoring until the next launch, while the old one still opened
           * the microphone from anywhere.
           */
          const syncGlobalShortcuts = async (settings: VoiceSettings) => {
            try {
              await invoke("unregister_global_voice_shortcuts")
              for (const chord of [settings.transcriptionChord, settings.agentChord]) {
                await invoke("register_global_voice_shortcut", { chord: toTauriChord(chord) })
              }
            } catch (err) {
              console.warn("Registrazione scorciatoia globale non riuscita:", err)
            }
          }

          await syncGlobalShortcuts(voiceSettings())
          registerGlobalShortcuts = syncGlobalShortcuts

          /*
           * The OS takes a registered hotkey before the webview sees the key,
           * so inside ADE's own window this event is the only keydown these
           * chords ever produce. It has to do everything the window listener
           * does for them: tell the two features apart by chord, and honour
           * push-to-talk on the release.
           */
          const unlisten = await listen<unknown>(GLOBAL_VOICE_EVENT, (event) => {
            const payload = readGlobalVoicePayload(event.payload)
            if (!payload) return
            const mode = modeForGlobalChord(payload.chord, voiceSettings(), platform)
            if (!mode) return

            if (voiceSettings().activation === "push-to-talk") {
              if (payload.state === "pressed") {
                const chord = mode === "agent" ? voiceSettings().agentChord : voiceSettings().transcriptionChord
                void pttHandler.onKeyDown(parseChord(chord, platform), { repeat: false }, mode)
              } else {
                // No key to compare: the native side already said the chord let go.
                void pttHandler.onKeyUp()
              }
              return
            }
            if (payload.state === "pressed") void voiceEngine.toggle(mode)
          })

          releaseGlobal = () => {
            releaseGlobal = undefined
            unlisten()
            registerGlobalShortcuts = undefined
            void invoke("unregister_global_voice_shortcuts").catch(() => {})
          }
          // Closed while the awaits above were still running.
          if (disposed) releaseGlobal()
        } catch (e) {
          console.warn("Inizializzazione scorciatoia globale saltata:", e)
        }
      })()
    }

    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown, true)
      window.removeEventListener("keyup", handleKeyUp, true)
      window.removeEventListener("blur", handleBlur)
      window.removeEventListener("beforeunload", handleBeforeUnload)
    })
  })

  // Commands
  const runCommand = async (id: string) => {
    // Returns, because the last line of this function closes the palette.
    // See `keepsPaletteOpen` for why that is not a detail.
    if (keepsPaletteOpen(id)) {
      setPaletteOpen(true)
      return
    }

    /*
     * Plugin commands are dispatched before ADE's own chain, and by shape
     * rather than by lookup in a list.
     *
     * `parseCommandId` only answers for the `plugin:<id>:<command>` form, and
     * `trust.ts` is what guarantees no ADE command can ever take that form —
     * so this branch cannot shadow a built-in, and a built-in cannot shadow a
     * plugin. The handler is still looked up in the registry: a command whose
     * plugin has been disposed since the palette drew the row is gone, and
     * running nothing is the right answer.
     */
    const qualified = parseCommandId(id)
    if (qualified) {
      const entry = pluginRuntime.registry.findCommand(id)
      // Awaited, so a command that throws is caught here rather than becoming
      // an unhandled rejection with no plugin named in it.
      if (entry) {
        await Promise.resolve()
          .then(() => entry.run())
          .catch((error) => {
            console.error(`[ade.plugin] ${entry.pluginId} command ${entry.commandId} failed`, error)
          })
      }
      setPaletteOpen(false)
      return
    }

    if (id === "session.new") {
      // A pane is born because a process is starting, never before: the button
      // opens the launch screen and the launch screen creates the panes.
      setStarting(true)
    } else if (id === "project.open") {
      const host = await getHost()
      if (host) {
        const p = await openProject(host)
        if (p) {
          setProject(p)
          // The panes of the project being left stay: their sessions keep running, and keep talking to the others.
          setWb(w => ({ ...w, projectPath: p.root, expandedId: undefined }))
          const newRecents = addRecent(recents(), { root: p.root, name: p.name })
          setRecents(newRecents)
          localStorage.setItem("ade.recents", serializeRecents(newRecents))
        }
      }
    } else if (id === "pane.close") {
      if (wb().focusedId) close(wb().focusedId!)
    } else if (id === "pane.expand") {
      if (wb().focusedId) setWb(w => expandPane(w, w.focusedId!))
    } else if (id === "pane.rename") {
      // Handled by the pane itself: the title is edited where it is shown.
      requestRename(wb().focusedId)
    } else if (id === "view.toggle") {
      setWb(w => ({ ...w, view: nextView(w.view) }))
    } else if (id.startsWith("view.")) {
      // Matched against the list rather than parsed off the id, so a command
      // called "view.anything" cannot put the workbench in a view that has no
      // branch to render it.
      const target = ADE_VIEWS.find((view) => `view.${view}` === id)
      if (target) setWb(w => ({ ...w, view: target }))
    } else if (id === "theme.toggle") {
      // The attribute goes on ADE's own root, not the document's: ADE is mounted
      // inside another application and must not restyle its host.
      themeState.toggle()
    } else if (id === "video.new") {
      /*
       * Opened empty. The panel has its own picker over the project's media,
       * and guessing a file would be guessing which of a dozen recordings
       * the user meant — and the agent can open one itself with
       * `@ade video open <percorso>`.
       */
      setWb(w => addPane(w, {
        id: `v${Date.now()}`,
        title: "Video",
        status: "working",
        model: "—",
        mode: "video",
        videoPath: "",
        workspaceId: project()?.name ?? "workspace",
        lines: []
      }))
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
        /*
         * The project's own id, like every other pane.
         *
         * "ws-browser" was not a workspace: `gridPanes` keeps only the panes
         * whose `workspaceId` matches the open project, so with a project open
         * the browser pane was created, given the focus, and then drawn
         * nowhere — and the next Ctrl+W closed a pane the user could not see.
         * It worked in the browser harness only because `project()` is
         * undefined there and the filter is skipped.
         */
        workspaceId: project()?.name ?? "workspace",
        lines: []
      }))
    } else if (id === "process.kill") {
      if (wb().focusedId && isRunning(wb().focusedId!)) {
        running.get(wb().focusedId!)?.kill()
        running.delete(wb().focusedId!)
        touchRunning()
        setWb(w => updatePane(w, w.focusedId!, { status: "error", activity: "Ucciso", lines: [...(w.panes.find(p=>p.id===w.focusedId)?.lines||[]), {kind:"note", text:"Processo ucciso"}] }))
      }
    } else if (id === "voice.toggle") {
      void voiceEngine.toggle()
    } else if (id === "voice.settings") {
      setVoiceSettingsOpen(true)
    } else if (id.startsWith("project.recent.")) {
      const root = id.slice("project.recent.".length)
      const host = await getHost()
      if (host) {
        const p = await discoverProject(host, root)
        setProject(p)
        setWb(w => ({ ...w, projectPath: p.root, expandedId: undefined }))
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
      voiceAvailable,
      voiceActive: voiceEngine.isRunning(),
      voiceChord: voiceSettings().agentChord,
      // Read through the registry signal, so a plugin loading or being torn
      // down changes the palette without anything having to refresh it.
      pluginCommands: pluginRuntime.registry.commands().map((command) => ({
        id: command.key,
        title: command.title,
        group: command.group,
        keywords: command.keywords,
      })),
    })
  })

  /*
   * Output goes to the pane's terminal whether or not that pane is on screen.
   * A session in a collapsed pane keeps running, and coming back to it must
   * show what happened while you were away rather than a gap.
   */
  /*
   * Working until the output goes quiet.
   *
   * Nothing else says when an interactive agent has finished its turn: the
   * process stays alive, so `finish` never runs, and a pane marked working
   * stayed working forever. Silence is the signal — an agent that is busy
   * animates, one waiting for the user does not.
   */
  const QUIET_MS = 2500
  const quietTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const settleWhenQuiet = (paneId: string) => {
    clearTimeout(quietTimers.get(paneId))
    quietTimers.set(paneId, setTimeout(() => {
      quietTimers.delete(paneId)
      if (wb().panes.find((pane) => pane.id === paneId)?.status !== "working") return
      setWb((w) => updatePane(w, paneId, { status: "idle", activity: "Disponibile" }))
    }, QUIET_MS))
  }
  const forgetQuiet = (paneId: string) => {
    clearTimeout(quietTimers.get(paneId))
    quietTimers.delete(paneId)
  }

  const feedTerminal = (paneId: string, chunk: string) => {
    /*
     * Nothing is written to a pane that no longer exists.
     *
     * `writeToTerminal` creates the xterm instance on demand, so a chunk
     * that arrived after `close` — and one always does, because killing a
     * process does not retract what it already wrote — resurrected a whole
     * terminal, buffer and all, for a pane with no card on screen and no
     * way to reach it. It was then never disposed, because `close` had
     * already run.
     */
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    if (!pane) return

    // A working agent keeps repainting (spinner, streamed text); every chunk
    // pushes back the moment the pane is declared idle again.
    if (pane.status === "working") settleWhenQuiet(paneId)

    writeToTerminal(paneId, chunk)
    if (!liveTerminals().has(paneId)) {
      setLiveTerminals((ids) => new Set(ids).add(paneId))
    }
  }

  /**
   * Adds a project to the list, by asking the system where it is.
   *
   * Adding, not replacing: the list is where the user keeps the projects they
   * work in, and picking a new one should not quietly evict the last. The
   * sessions of the project being left keep running — they have their own
   * checkouts — and its row stays in the list to go back to.
   */
  const addProject = async () => {
    const host = await getHost()
    if (!host) return
    const picked = await openProject(host)
    if (!picked) return
    const newRecents = addRecent(recents(), { root: picked.root, name: picked.name })
    setRecents(newRecents)
    localStorage.setItem("ade.recents", serializeRecents(newRecents))
    setProject(picked)
    // Same reason as switchProject: an expansion made in another project
    // narrows this one's grid to nothing.
    setWb((w) => ({ ...w, projectPath: picked.root, expandedId: undefined }))
    setStarting(false)
  }

  /**
   * Switches to a project already on disk, by its root.
   *
   * Split out of `switchProject` for voice, which resolves a spoken project
   * name to a root of its own and must not go through
   * `runCommand("project.recent.…")`: that one rebuilds the workbench from
   * scratch, and a spoken "apri nikcli e avvia due sessioni" would throw away
   * every pane of the project being left.
   */
  const switchProjectTo = async (root: string) => {
    const current = project()
    // Compared as a path: the same directory reaches this spelled both ways.
    if (current && pathEquals(current.root, root)) return
    const host = await getHost()
    if (!host) return
    const opened = await discoverProject(host, root)
    setProject(opened)
    /*
     * The expansion belongs to the project it was made in.
     *
     * `gridPanes` keeps the panes of the open project and then, if
     * `expandedId` is set, narrows to that one — so an id left over from
     * another project narrows to nothing. The new project showed the launch
     * screen however many sessions it had running, with no visible control to
     * get out of an expansion the user could not see.
     */
    setWb((w) => ({ ...w, projectPath: opened.root, expandedId: undefined }))
    setStarting(false)
  }

  /** Switches to a project already in the list, by the name its row carries. */
  const switchProject = async (id: string) => {
    const entry = recents().find((candidate) => candidate.name === id)
    if (!entry) return
    await switchProjectTo(entry.root)
  }

  /**
   * Opens a session from its row in the sidebar.
   *
   * The row used to set `focusedId` and nothing else, so clicking a session
   * did nothing visible whenever it was not already on screen: in another
   * project, behind another section (`agent`, `chat`), or outside an
   * expansion of a different pane. Opening it means making it the thing on
   * screen — its project, the terminals section, and that session expanded —
   * the same place a new session lands.
   */
  const openSession = async (id: string) => {
    const pane = wb().panes.find((candidate) => candidate.id === id)
    if (!pane) return
    const owner = pane.workspaceId
    if (owner && owner !== project()?.name) {
      const entry = recents().find((candidate) => candidate.name === owner)
      if (entry) await switchProjectTo(entry.root)
    }
    // The new-session form covers the grid while it is open.
    setStarting(false)
    setWb((w) => ({ ...w, view: "code", focusedId: id, expandedId: id }))
  }

  /**
   * Everything keyed by pane id, forgotten in one place.
   *
   * `close` used to clear the process, the terminal and the pane, and leave
   * seven maps holding entries for a pane that no longer exists. They grew for
   * as long as ADE stayed open.
   */
  const forgetPane = (id: string) => {
    records.forget(id)
    rawWindows.forget(id)
    forgetQuiet(id)
    // Per-pane bookkeeping kept in plain maps, which nothing else clears: a
    // long day of opening and closing sessions used to keep every one of them.
    lastOutputAt.delete(id)
    usageOf.delete(id)
    paneTokens.delete(id)
    paneNonces.delete(id)
    activityOf.delete(id)
    bracketedPaste.delete(id)
  }

  const close = (id: string) => {
    /*
     * An unsaved file is not closed without asking.
     *
     * The buffer model has always known whether there is anything to lose;
     * nothing asked it. Closing a file pane — by the X, by Ctrl+W, or by the
     * command — dropped the draft with no warning and no way back.
     */
    const buffer = buffers()[id]
    if (buffer?.dirty) {
      const discard = confirm(
        `${buffer.path}\n\nCi sono modifiche non salvate. Chiudendo, vengono perse.\n\nChiudere comunque?`,
      )
      if (!discard) return
    }

    running.get(id)?.kill()
    running.delete(id)
    touchRunning()
    disposeTerminal(id)
    setLiveTerminals((ids) => {
      if (!ids.has(id)) return ids
      const next = new Set(ids)
      next.delete(id)
      return next
    })
    forgetPane(id)
    // The registry has to hear about it too, or `ui.pane.list()` keeps
    // reporting a tile the user closed and the plugin's own "already open"
    // check refuses to reopen it.
    pluginRuntime.registry.closePane(id)
    setWb(w => closePane(w, id))
  }

  const finish = (id: string, code: number | null) => {
    running.delete(id)
    touchRunning()
    forgetQuiet(id)
    setWb(w => updatePane(w, id, {
      status: code === 0 ? "done" : "error",
      activity: code === 0 ? "Fatto" : `Uscito con ${code}`
    }))
  }

  /*
   * The project's file list, walked once and kept.
   *
   * Walking a repository costs seconds; doing it on every keystroke would make
   * the search box unusable on exactly the projects where search matters. The
   * list is read on the first query and reused until the project changes —
   * or until it is old enough that files created since would be missing. A
   * stale list still answers at once; the fresh one replaces it for the next
   * keystroke.
   */
  type Walked = { root: string; at: number; entries: { path: string; kind: "file" | "directory" }[] }
  const WALK_FRESH_MS = 30_000
  let walked: Walked | undefined
  let walkingPromise: Promise<Walked> | undefined

  const searchProjectFiles = async (query: string, kinds: ReadonlySet<"file" | "directory">) => {
    const host = await getHost()
    const current = project()
    if (!host || !current) return []

    const sameRoot = walked?.root === current.root
    if (!sameRoot || Date.now() - walked!.at > WALK_FRESH_MS) {
      if (!walkingPromise) {
        walkingPromise = walkProject({ host, root: current.root })
          .then((result) => {
            const entry: Walked = {
              root: current.root,
              at: Date.now(),
              entries: [
                ...(result.dirs ?? []).map((path) => ({ path, kind: "directory" as const })),
                ...result.files.map((path) => ({ path, kind: "file" as const })),
              ],
            }
            walked = entry
            walkingPromise = undefined
            return entry
          })
          .catch((err) => {
            walkingPromise = undefined
            throw err
          })
      }
      // Only a different project has to wait; a merely old list answers now.
      if (!sameRoot) await walkingPromise
    }

    if (!walked) return []
    return searchPaths(walked.entries, query, { root: current.root, kinds, limit: 200 })
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

    bufferLoading.set(id, true)
    try {
      const read = await host.readTextFile(path)
      buffers.set(id, openBuffer({ path, text: read.text, truncated: read.truncated }))
    } catch (error) {
      appendLine(id, error instanceof Error ? error.message : String(error))
    } finally {
      bufferLoading.set(id, false)
    }
  }

  const saveFile = async (paneId: string) => {
    const buffer = buffers()[paneId]
    const host = await getHost()
    if (!buffer || !host?.writeTextFile) return
    if (saveBlockedReason(buffer)) return

    /*
     * What somebody else did to the file while it was open.
     *
     * The agents write into the project, and with sessions running in the
     * project directory rather than a checkout of their own that is the same
     * file the editor is holding. Nothing compared the two, so a save silently
     * replaced the agent's version with a copy of the file as it was when the
     * pane opened it.
     */
    if (host.readTextFile) {
      /*
       * A read that failed is not a file that did not change.
       *
       * The `.catch(() => undefined)` here undid the whole check: with
       * `onDisk` undefined the comparison below was skipped and the save
       * went ahead unasked — which is the same overwrite this block exists
       * to prevent, reached by a different route. `readTextFile` throws on
       * purpose (`host/shell.ts`), and the honest answer to "I could not
       * look" is to ask rather than to assume.
       */
      let onDisk: Awaited<ReturnType<NonNullable<typeof host.readTextFile>>> | undefined
      let unreadable: string | undefined
      try {
        onDisk = await host.readTextFile(buffer.path)
      } catch (error) {
        unreadable = error instanceof Error ? error.message : String(error)
      }

      if (unreadable !== undefined) {
        const anyway = confirm(
          `${buffer.path}\n\nNon riesco a rileggere il file per controllare se è cambiato (${unreadable}).\n\nSalvare comunque, sostituendo quello che c'è sul disco?`,
        )
        if (!anyway) {
          report(`Salvataggio annullato: non ho potuto rileggere il file (${unreadable}).`, "warning")
          return
        }
      } else if (onDisk && !onDisk.truncated && onDisk.text !== buffer.saved) {
        const overwrite = confirm(
          `${buffer.path}\n\nIl file è cambiato su disco da quando l'hai aperto. Salvando, quelle modifiche vengono sostituite dalle tue.\n\nProcedere?`,
        )
        if (!overwrite) {
          report("Salvataggio annullato: il file è cambiato su disco.", "warning")
          return
        }
      }
    }

    // Captured before the await, so what gets written and what gets recorded
    // as written are the same string.
    const written = buffer.draft

    const error = await host.writeTextFile(buffer.path, written)
    if (error) {
      report(`Salvataggio fallito: ${error}`)
      return
    }

    /*
     * The entry as it is now, not the one captured above.
     *
     * Writing to disk is a round trip, and the user goes on typing during it.
     * Putting the captured buffer back replaced the draft with the older one —
     * the characters typed during the save were gone, the cursor jumped,
     * and the buffer was marked clean while holding text nobody had saved.
     */
    buffers.update(paneId, (now) => (now ? markSaved(now, written) : now))
  }

  const appendLine = (id: string, text: string, kind: "step" | "shell" | "note" = "note") => {
    /*
     * What is stored is the readable form; what is inspected below is the raw
     * line.
     *
     * A permission prompt or a cost can sit inside a frame far longer than a
     * transcript line is allowed to be, so the detectors keep the whole thing
     * and only the transcript is trimmed.
     */
    const shown = cleanTranscriptLine(text)
    if (shown !== undefined) {
      /*
       * The one write that happens thousands of times a minute, so it is the
       * one that does not rebuild the workbench.
       *
       * `produce` pushes onto the one array that grew. Going through the pure
       * reducers instead would copy the pane, the pane list and the workbench
       * for every line, and then hand `reconcile` the whole thing to diff —
       * per line, per agent.
       */
      setWbStore(
        produce((w) => {
          const pane = w.panes.find((p) => p.id === id)
          if (!pane) return
          // A frame redrawn is the same line again; one entry says as much.
          if (pane.lines.at(-1)?.text === shown) return
          pane.lines.push({ kind, text: shown })
          if (pane.lines.length > MAX_PANE_LINES) {
            pane.lines.splice(0, pane.lines.length - MAX_PANE_LINES)
          }
        }),
      )
      setRevision((n) => n + 1)
    }
    watchForPermission(id, text)

    // Agents print what they are spending in among everything else. Reading it
    // here is the only way the pane's counters are real rather than decorative.
    reports.update(id, (before) => {
      // `readReportLine` hands the same object back when the line said nothing
      // about spending, which is almost every line: comparing against it keeps
      // a pane out of the map entirely until it has something to report.
      const base = before ?? {}
      const after = readReportLine(base, text)
      return after === base ? before : after
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

    /*
     * The raw window, not the transcript.
     *
     * A window rather than the one line that just arrived, because a redrawn
     * frame is many lines and one of them cannot say whether the question is
     * still on screen. Raw, because the transcript is cleaned on the way in
     * — truncated at 400 characters and stripped of frame-only lines — and a
     * full-screen agent paints its prompt inside a frame far wider than that.
     * Reading the cleaned copy meant the detector never saw the very case it
     * exists for.
     */
    const recent = rawWindows.push(paneId, text)
    const agent = pane.agent ?? pane.model

    const pending = permissions()[paneId]
    if (pending) {
      if (!isResolved(pending, recent, agent)) return
      permissions.forget(paneId)
      // The agent moved on by itself, so the pane is working again.
      setWb((w) => updatePane(w, paneId, { status: "working", activity: "In esecuzione" }))
      return
    }

    const request = detectPermission(recent, agent)
    if (!request) return

    permissions.set(paneId, request)
    setWb((w) => updatePane(w, paneId, { status: "waiting", activity: "In attesa di permesso" }))
    if (voiceEngine.isRunning()) {
      void voiceEngine.handlePermissionRequest(paneId, request.what)
    }
  }

  /** Answers a pending question on the process's own stdin, where it was asked. */
  const answerPermission = (paneId: string, answer: PermissionAnswer) => {
    const session = running.get(paneId)
    if (!session) return

    /*
     * Terminated, or the agent never receives it.
     *
     * `answer.send` is the keystroke that picks the answer; `\r` is the Enter
     * that submits it. Writing the keystroke alone left it sitting unread in
     * the agent's input buffer while the two lines below cleared the request
     * and told the user the session was running again — the interface said
     * answered, the agent was still waiting.
     */
    session.write(asSubmittedLine(answer.send))
    appendLine(paneId, `> ${answer.label}`, "shell")

    /*
     * The request is not cleared here.
     *
     * Whether the answer worked is something only the agent's next output can
     * say, and `watchForPermission` reads it: when the question stops being on
     * screen the request goes and the pane goes back to working. Clearing it
     * from this side is how ADE used to claim an answer had landed when it had
     * not — which matters most for the menus that need arrow keys rather than
     * a number, where the keystroke above genuinely does nothing.
     */
  }

  /*
   * The opening-task polls, held where a cleanup can still reach them.
   *
   * `startProcess` is async and has awaited `getHost()` and `host.spawn()`
   * before it starts one, and after an await Solid's owner is null — so the
   * `onCleanup(() => clearInterval(poll))` that used to sit next to the
   * `setInterval` was never registered and never ran. Nothing said so: the
   * call returns normally, and the interval simply outlived the surface,
   * firing every 100 ms against a workbench that no longer exists.
   *
   * Registering the cleanup synchronously, during setup, is the shape that
   * actually works; the set is what gives it something to clear.
   */
  const openingPolls = new Set<ReturnType<typeof setInterval>>()
  const stopOpeningPoll = (poll: ReturnType<typeof setInterval>) => {
    clearInterval(poll)
    openingPolls.delete(poll)
  }
  onCleanup(() => {
    for (const poll of openingPolls) clearInterval(poll)
    openingPolls.clear()
  })

  /**
   * Starts the process behind a pane.
   *
   * `resume` is what a restore passes: the arguments that reopen a
   * conversation the agent already has, instead of the ones that start a new
   * one. When it is given, the opening task is *not* typed — the agent is
   * being handed back its own thread, and retyping the original prompt into
   * it would ask for the whole job a second time.
   */
  /**
   * True when the agent was never made to write the conversation `resumeId`
   * names — see `ResumeRecipe.transcript`. False whenever it cannot be told:
   * an id that cannot be checked is trusted, as it was before.
   */
  // `cwd` is where the agent ran: a worktree session's transcripts are filed under the worktree, not the project.
  const conversationMissing = async (agentId: string, resumeId: string | undefined, cwd?: string) => {
    const host = await getHost()
    const root = cwd || project()?.root
    if (!resumeId || !root || !host?.homeDir || !host.exists) return false
    const home = await host.homeDir().catch(() => "")
    const path = home ? RESUME[agentId]?.transcript?.(home, root, resumeId) : undefined
    return path ? !(await host.exists(path)) : false
  }

  /**
   * Brings a session with no process back from its own pane.
   *
   * A restored session whose agent had already exited — or one that exited
   * because its resume failed — was left as a transcript with a disabled
   * input and nothing to press: the conversation was still on disk and the
   * pane had no way to reach it. Now the pane reopens it by id when it can,
   * and `line`, when the user typed one, is sent once the agent is ready.
   */
  const reopen = async (pane: Pane, line?: string) => {
    const agentId = pane.agent ?? pane.model
    if (running.has(pane.id)) return
    const missing = await conversationMissing(agentId, pane.resumeId, pane.cwd)
    const plan = planResume({
      agentId,
      ...(pane.resumeId ? { resumeId: pane.resumeId } : {}),
      // "The most recent one here" only when this is the one pane of that
      // agent: with two, the latest thread is as likely the other's.
      lastTaken: wb().panes.some((other) => other.id !== pane.id && (other.agent ?? other.model) === agentId),
      missing,
    })
    const text = line?.trim() ? line : plan.kind === "fresh" ? (pane.task ?? "") : ""
    await startProcess(pane.id, agentId, text, plan, undefined, Boolean(line?.trim()))
  }

  /**
   * The project a pane's process runs in: its own, not whichever is open.
   *
   * Panes of every project stay in the workbench and keep talking to each
   * other, so a session of a project that is not on screen — restarted, or
   * spawned by one of its agents — has to start in its own root. Found by
   * name among the known projects; the open one when the pane's is unknown.
   */
  const projectOfPane = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, paneId: string): Promise<Project | undefined> => {
    const open = project()
    const owner = wb().panes.find((pane) => pane.id === paneId)?.workspaceId
    if (!owner || owner === open?.name) return open
    const entry = recents().find((candidate) => candidate.name === owner)
    if (!entry) return open
    return discoverProject(host, entry.root).catch(() => open)
  }

  const startProcess = async (
    paneId: string,
    agentId: string,
    task: string,
    resume?: ResumePlan,
    /*
     * Arguments this particular session needs, on top of whatever opening the
     * agent's own plan asks for.
     *
     * Used by the bot section, where a session is `nikcli --agent <name>`: the
     * bot *is* those two arguments, and starting the CLI bare would open a
     * plain session that has never heard of it.
     */
    extra?: readonly string[],
    /** Type `task` even into a resumed conversation: the user just wrote it. */
    typeIntoResumed = false,
  ) => {
    const agent = agentById(agentId)
    const host = await getHost()
    const p = host ? await projectOfPane(host, paneId) : undefined
    if (!agent || !agent.command || !host || !p) return
    if (p.remote) return startRemoteProcess(paneId, agentId, agent.command, task, p.remote, host)

    /*
     * The conversation id is chosen here, before the agent exists.
     *
     * Only some CLIs accept one — `resume.ts` has the table — and for those
     * it is the difference between coming back to the session and starting
     * an identical-looking new one. Recorded on the pane in the same breath,
     * because a pane that is running under an id ADE did not write down is
     * a session that cannot be resumed and looks like one that can.
     */
    const resumed = resume?.kind === "resume"
    const opening = resume?.kind === "resume" ? { args: resume.args } : planStart(agentId, resume?.resumeId)
    /*
     * The `ade-msg` notice first: `codex -c …` has to precede a `resume`
     * subcommand, and for the rest the order does not matter. The shell has
     * no instructions to extend and gets nothing. See `session-new/intro.ts`.
     */
    /*
     * A spawned session keeps what it was spawned with: its worktree is its
     * directory, and its `--model` (or agy's `--add-dir`) comes back on every
     * restart. Before the opening, like the notice, so a `resume` subcommand
     * still comes after the flags.
     */
    const launched = wb().panes.find((pane) => pane.id === paneId)
    const workDir = launched?.worktree || p.root
    const extraArgs = [...introArgs(agentId), ...(launched?.spawnArgs ?? []), ...opening.args, ...(extra ?? [])]
    const mintedId = "resumeId" in opening ? opening.resumeId : undefined

    /*
     * And the other direction: the CLI telling ADE which conversation it
     * opened.
     *
     * For codex there is no flag to pin an id, so this is the only way a pane
     * can be brought back to its own thread rather than to whatever codex
     * used last. For Claude Code it covers what the flag cannot: a
     * conversation the user resumed or cleared from inside the CLI has a new
     * id, and the pane would otherwise still be carrying the one ADE minted.
     *
     * Only when the user has installed the hook — see the settings panel.
     * Without it the variables are not set, and nothing changes.
     */
    const linked = hookStates()[agentId]?.installed ?? false
    const nonce = linked ? newNonce() : undefined
    // Kept per pane so turn activity can be read for as long as this spawn lives.
    if (nonce) paneNonces.set(paneId, nonce)
    else paneNonces.delete(paneId)
    activityOf.delete(paneId)
    bracketedPaste.delete(paneId)
    let spawned: SpawnedSession | undefined

    /*
     * The project itself, not a worktree cut for the session.
     *
     * Every session used to be provisioned onto its own branch in its own
     * checkout, which meant opening a terminal put you somewhere that was not
     * the project you opened: a different path, a branch you did not ask for,
     * and your own work invisible from it. Branching is the user's decision and
     * they make it in the terminal like anywhere else. The worktree board still
     * lists and integrates the trees that exist — it just stops making them.
     */
    try {
      const hasTask = Boolean(task.trim())
      setWb(w => updatePane(w, paneId, {
        cwd: workDir,
        tree: launched?.worktree && launched.tree
          ? launched.tree
          : p.branch ? { branch: p.branch, fidelity: "project" } : undefined,
        status: hasTask ? "working" : "idle",
        activity: resumed ? "Sessione ripresa" : (hasTask ? "In esecuzione" : "Disponibile"),
        // A fresh start drops an id whose conversation is gone, so the pane
        // stops promising to reopen it.
        ...(mintedId ? { resumeId: mintedId } : resume?.kind === "fresh" ? { resumeId: undefined } : {}),
      }))

      appendLine(paneId, `${workDir}> ${[agent.command, ...displayArgs(extraArgs)].join(" ")}`, "shell")

      /*
       * Started bare, the way the user would start it in their own terminal.
       *
       * No per-agent one-shot arguments any more: those turned every session
       * into a single question with no way to ask a second one, and for Claude
       * Code the argument-free form was not even reachable — without a terminal
       * it switched itself into `--print` and exited before the pane had drawn.
       * With a pty there is nothing to work around: whatever the agent does when
       * you run it yourself is what it does here.
       */
      /*
       * When the CLI first spoke, and when it last did.
       *
       * Both are needed to know the screen is drawn: the first byte says the
       * program is alive, the gap since the last one says it has stopped
       * repainting. See `decideOpening`.
       */
      let firstByteAt: number | undefined
      let lastByteAt: number | undefined

      const session = await host.spawn({
        command: agent.command,
        args: extraArgs,
        cwd: workDir,
        onData: (chunk) => {
          const now = Date.now()
          firstByteAt ??= now
          lastByteAt = now
          lastOutputAt.set(paneId, now)
          noteBracketedPaste(paneId, chunk)

          feedTerminal(paneId, chunk)
        },
        onLine: (line, stream) => {
          appendLine(paneId, line, stream === "err" ? "note" : "step")
          /*
           * The same line the transcript got, read once more for a request
           * addressed to a panel.
           *
           * `onLine` is already where every line is inspected — it is how a
           * permission prompt is noticed — so this costs one more parse on a
           * line that has already been split, and it is the only channel that
           * works with every CLI ADE runs: they read keystrokes and write
           * text, and this is text.
           */
          void handlePanelRequest(paneId, line)
        },
        /*
         * Only this spawn's exit ends the pane. A relaunch kills the old process
         * and starts the new one at once, and the old one's exit arriving later
         * must not mark the new session finished.
         */
        onExit: (code) => {
          if (!running.has(paneId) || running.get(paneId) === spawned) finish(paneId, code)
        },
        ...(nonce ? { link: { pane: paneId, nonce } } : {}),
        pane: paneId,
        paneToken: mintPaneToken(paneId),
      })

      spawned = session
      running.set(paneId, session)
      touchRunning()

      /*
       * Learning the id from the CLI's own record, for the ones that keep one.
       *
       * agy takes no id up front and has no hook ADE installs, but it writes
       * the latest conversation per directory to a file. What it said before
       * this session started is not ours; an id that shows up afterwards is,
       * unless another pane already holds it. Without this a restored agy
       * pane had nothing to ask for and came back as a new conversation.
       */
      const latest = RESUME[agentId]?.latest
      if (latest && !mintedId && host.homeDir && host.readTextFile) {
        const readText = host.readTextFile
        const home = await host.homeDir().catch(() => "")
        const readLatest = async () =>
          home
            ? latest.read((await readText(latest.path(home), 1_000_000).catch(() => undefined))?.text ?? "", p.root)
            : undefined
        const before = await readLatest()
        const poll = setInterval(async () => {
          if (running.get(paneId) !== session) {
            stopOpeningPoll(poll)
            return
          }
          const id = await readLatest()
          if (!id || id === before) return
          const panes = wb().panes
          if (panes.some((pane) => pane.id !== paneId && pane.resumeId === id)) return
          if (panes.find((pane) => pane.id === paneId)?.resumeId === id) return
          setWb((w) => updatePane(w, paneId, { resumeId: id }))
          // Up to 1 MB read per pass, for the life of the session: often enough
          // to catch a new conversation, not so often that it is the busiest
          // thing an idle agy pane does.
        }, 10_000)
        openingPolls.add(poll)
      }

      /*
       * Wait for the hook to say who the agent turned out to be.
       *
       * Not awaited: the session is live and the user is typing into it well
       * before the CLI reaches its own `SessionStart`, and there is nothing
       * to show for the wait. If it never answers the pane keeps whatever id
       * ADE minted, or none, which is exactly the behaviour without a hook.
       *
       * The pane is looked up again when the answer lands rather than
       * captured: by then it may have been closed, or restarted into a
       * different session, and writing an id onto a pane that has moved on
       * is worse than not writing one.
       */
      if (nonce) {
        // And after it: a `/resume` or `/clear` inside the CLI moves the pane too.
        void followReports({
          pane: paneId,
          nonce,
          read: (n) => host.readAgentLink?.(n) ?? Promise.resolve(null),
          clear: async (n) => {
            await host.clearAgentLink?.(n)
          },
          cancelled: () => running.get(paneId) !== session,
          onReport: (report) => {
            if (running.get(paneId) !== session) return
            setWb((w) => updatePane(w, paneId, { resumeId: report.sessionId }))
          },
        })
      }

      /*
       * An opening task is typed in, not passed as an argument. It is the same
       * keystrokes the user would have made, so it works identically for all
       * eleven CLIs and leaves the session live afterwards — which a one-shot
       * flag never did.
       *
       * When to type it was a fixed 900 ms after spawn, and that was wrong for
       * most of the catalogue: five of the nine installed agents need longer
       * than that just to print their version. The text landed in a buffer
       * nobody was reading, or its Enter answered the CLI's own first question.
       * Now the session is polled until the output has actually settled, and
       * never typed into while a permission prompt is standing.
       */
      // Not typed when the session was resumed: the agent already has the
      // thread, and sending the original prompt again would ask for the whole
      // job a second time.
      if (task.trim() && (!resumed || typeIntoResumed)) {
        const startedAt = Date.now()
        const poll = setInterval(() => {
          // The pane was closed, or the process died, while we were waiting.
          if (!running.has(paneId)) {
            stopOpeningPoll(poll)
            return
          }

          const decision = decideOpening({
            startedAt,
            firstByteAt,
            lastByteAt,
            now: Date.now(),
            permissionPending: Boolean(permissions()[paneId]),
          })
          if (decision === "wait") return

          stopOpeningPoll(poll)
          if (decision === "send") {
            setWb(w => updatePane(w, paneId, {
              status: "working",
              activity: "In esecuzione",
            }))
            // Opening tasks only — a line the user typed later is theirs alone.
            // Text and Enter apart, for the reason `typeLine` gives.
            const session = running.get(paneId)
            if (session) void typeLine(session, typeIntoResumed ? task : withIntro(agentId, task))
            return
          }
          /*
           * Said, not swallowed. An opening task that was never delivered is
           * the user's sentence going missing; they need to know it is still
           * theirs to send, and the terminal is where they are looking.
           */
          setWb(w => updatePane(w, paneId, {
            status: "idle",
            activity: "Disponibile",
          }))
          noteInTerminal(
            paneId,
            "ADE non ha inviato il compito iniziale: la sessione non si è stabilizzata. Scrivilo tu quando è pronta.",
          )
          appendLine(paneId, "Compito iniziale non inviato: sessione non pronta.", "note")
        }, 100)
        openingPolls.add(poll)
      }

    } catch (e) {
      appendLine(paneId, String(e))
      setWb(w => updatePane(w, paneId, { status: "error", activity: "Avvio fallito" }))
    }
  }

  /**
   * A session in a remote Space: ssh to the host, into its folder, then the
   * agent typed at the remote prompt the way the user would type it.
   *
   * Nothing local comes along — no resume id, no hook, no `ade-msg` notice:
   * those live on this machine, and the agent is on another one. What is typed
   * waits for the connection to settle and never goes into a password,
   * passphrase or fingerprint question; the user answers those in the pane.
   */
  const startRemoteProcess = async (
    paneId: string,
    agentId: string,
    command: string,
    task: string,
    target: RemoteTarget,
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
  ) => {
    const args = sshArgs(target)
    const home = host.homeDir ? await host.homeDir().catch(() => undefined) : undefined
    const shellOnly = agentId === "terminal"
    paneNonces.delete(paneId)
    activityOf.delete(paneId)
    bracketedPaste.delete(paneId)
    setWb((w) =>
      updatePane(w, paneId, {
        cwd: remoteRoot(target),
        tree: undefined,
        resumeId: undefined,
        status: task.trim() ? "working" : "idle",
        activity: "Connessione ssh",
      }),
    )
    appendLine(paneId, `ssh ${args.join(" ")}`, "shell")

    let tail = ""
    let spawned: SpawnedSession | undefined
    try {
      const session = await host.spawn({
        command: "ssh",
        args,
        ...(home ? { cwd: home } : {}),
        onData: (chunk) => {
          lastOutputAt.set(paneId, Date.now())
          noteBracketedPaste(paneId, chunk)
          tail = (tail + stripAnsi(chunk)).slice(-400)
          feedTerminal(paneId, chunk)
        },
        onLine: (line, stream) => appendLine(paneId, line, stream === "err" ? "note" : "step"),
        onExit: (code) => {
          if (!running.has(paneId) || running.get(paneId) === spawned) finish(paneId, code)
        },
        pane: paneId,
        paneToken: mintPaneToken(paneId),
      })
      spawned = session
      running.set(paneId, session)
      touchRunning()

      const steps = [...(shellOnly ? [] : [command]), ...(task.trim() ? [task] : [])]
      if (steps.length === 0) return
      let index = 0
      let stepStart = Date.now()
      let stepFirst: number | undefined
      const poll = setInterval(() => {
        if (running.get(paneId) !== session) {
          stopOpeningPoll(poll)
          return
        }
        const last = lastOutputAt.get(paneId)
        if (last !== undefined && last > stepStart) stepFirst ??= last
        const lastLine = tail.split(/\r?\n|\r/).filter((line) => line.trim()).pop() ?? ""
        const decision = decideOpening({
          startedAt: stepStart,
          firstByteAt: stepFirst,
          lastByteAt: stepFirst === undefined ? undefined : last,
          now: Date.now(),
          permissionPending: sshAsking(lastLine) || Boolean(permissions()[paneId]),
          // The first step waits out a password typed by hand.
          ...(index === 0 ? { timeoutMs: 180_000 } : {}),
        })
        if (decision === "wait") return
        if (decision === "abandon") {
          stopOpeningPoll(poll)
          noteInTerminal(paneId, `ADE non ha scritto «${steps[index]}»: la connessione non si è stabilizzata. Scrivilo tu.`)
          setWb((w) => updatePane(w, paneId, { status: "idle", activity: "Disponibile" }))
          return
        }
        const text = steps[index]!
        index += 1
        void typeLine(session, text)
        setWb((w) => updatePane(w, paneId, { activity: index < steps.length || !task.trim() ? "Connesso" : "In esecuzione" }))
        if (index >= steps.length) {
          stopOpeningPoll(poll)
          return
        }
        stepStart = Date.now()
        stepFirst = undefined
      }, 150)
      openingPolls.add(poll)
    } catch (e) {
      appendLine(paneId, String(e))
      setWb((w) => updatePane(w, paneId, { status: "error", activity: "Connessione fallita" }))
    }
  }

  /** Adds a remote Space, makes it the one in use, and opens a terminal on it. */
  const addRemoteSpace = async (target: RemoteTarget) => {
    const host = await getHost()
    if (!host) return
    const opened = await discoverProject(host, remoteRoot(target))
    const newRecents = addRecent(recents(), { root: opened.root, name: opened.name })
    setRecents(newRecents)
    localStorage.setItem("ade.recents", serializeRecents(newRecents))
    setProject(opened)
    setWb((w) => ({ ...w, projectPath: opened.root, expandedId: undefined }))
    setRemoteOpen(false)
    if (!wb().panes.some((pane) => pane.workspaceId === opened.name)) {
      addAgent(
        { agentId: "terminal", count: 1, task: "", title: `ssh ${target.destination}` },
        { index: 1, agentId: "terminal", role: "shell" },
      )
    }
  }

  /**
   * Starts the sessions a launch describes — the ones the form promised.
   *
   * `willLaunch` decides what each slot is: which agent, and whether it is an
   * agent, a reviewer, or the shell a workbench preset puts in slot two. The
   * form has always drawn its "Partirà" list from it, and the launch used to
   * ignore it entirely and start `count` copies of the chosen agent. Picking
   * "Banco di lavoro" showed "2. Terminal — shell" and started a second copy
   * of the same agent instead.
   */
  const launchSessions = (input: { agentId: string; count: number; task: string; preset?: string }) => {
    const entries = willLaunch({
      preset: input.preset as PresetId | undefined,
      agentId: input.agentId,
      count: input.count,
    })
    for (const entry of entries) addAgent(input, entry)
  }

  const addAgent = (
    input: {
      agentId: string
      count: number
      task: string
      preset?: string
      title?: string
      workspaceId?: string
      /** A spawned session's own checkout, with the branch it is on. */
      worktree?: { path: string; branch: string }
      spawnArgs?: string[]
      /** Start as a fork of another conversation: the arguments, and the child's id when known. */
      fork?: { args: string[]; resumeId?: string }
    },
    entry: LaunchEntry,
  ) => {
    const id = `n${Date.now()}-${entry.index}-${++paneSequence}`
    // A shell slot opens a terminal, so the task the form collected is meant
    // for the agent beside it, not for a prompt nothing will read.
    const task = entry.role === "shell" ? "" : input.task
    const hasInitialTask = Boolean(task.trim())
    const title = input.title || task || `${ROLE_LABEL[entry.role]} ${entry.index} — ${agentLabel(entry.agentId)}`
    const open = project()
    // Another project's session (a subagent spawned from there) keeps that project's name; its root is found at start.
    const currentProj = input.workspaceId && input.workspaceId !== open?.name ? undefined : open
    setWb(w => addPane(w, {
      id,
      title,
      // If there is an initial task, provisioning begins; otherwise idle ("disponibile")
      status: hasInitialTask ? "provisioning" : "idle",
      activity: hasInitialTask ? "Inizializzazione" : "Disponibile",
      model: entry.agentId,
      agent: entry.agentId,
      mode: input.preset ?? "custom",
      task,
      lines: [{ kind: "note", text: task || "Nessun task iniziale" }],
      workspaceId: input.workspaceId || currentProj?.name || "workspace",
      cwd: input.worktree?.path ?? currentProj?.root,
      tree: input.worktree
        ? { branch: input.worktree.branch, fidelity: "full", note: `Worktree ${input.worktree.path}` }
        : currentProj?.branch ? { branch: currentProj.branch, fidelity: "project" } : undefined,
      ...(input.worktree ? { worktree: input.worktree.path } : {}),
      ...(input.spawnArgs?.length ? { spawnArgs: input.spawnArgs } : {}),
      ...(input.fork?.resumeId ? { resumeId: input.fork.resumeId } : {}),
    }))
    setStarting(false)
    // A fork opens as a resumed conversation, and the task is typed into it all the same.
    if (input.fork) void startProcess(id, entry.agentId, task, { kind: "resume", via: "id", args: input.fork.args }, undefined, true)
    else void startProcess(id, entry.agentId, task)
    // Handed back for the callers that need to keep talking to the pane they
    // just made; `launchSessions` ignores it.
    return { id, title }
  }

  /**
   * One session, started exactly the way the launch form starts one.
   *
   * This is `addAgent` with its result kept rather than a second copy of the
   * pane-creation logic: voice needs the pane id back, because a spoken plan
   * sends its follow-up prompts to the session it just opened. The slot number
   * continues the open project's own count, so an unnamed session reads as
   * "Sessione 3 — Claude Code" next to the two already there.
   */
  const openVoiceSession = (input: { agentId: string; task: string }) => {
    const owner = project()?.name
    const mine = owner ? wb().panes.filter((p) => p.workspaceId === owner) : wb().panes
    const created = addAgent(
      { agentId: input.agentId, count: 1, task: input.task },
      { index: mine.length + 1, agentId: input.agentId, role: "agent" },
    )
    return { paneId: created.id, title: created.title }
  }

  /**
   * Opens a session as one of the bots — which is to say, as a nikcli agent.
   *
   * `nikcli --agent <name>` and nothing else: the same line the user would
   * type, in a real terminal, with the bot's persona and its tools and its
   * pinned model already in the file nikcli reads. The view switches to the
   * grid because otherwise the session starts somewhere the user is not
   * looking, and a button that appears to do nothing is worse than one that
   * takes you where it went.
   */
  const openBotSession = (bot: AgentFile) => {
    const launch = botLaunch(bot)
    if (!launch) return undefined
    const owner = project()?.name
    const mine = owner ? wb().panes.filter((p) => p.workspaceId === owner) : wb().panes
    const id = `n${Date.now()}-bot-${++paneSequence}`

    setWb((w) => addPane(w, {
      id,
      title: bot.identifier,
      status: "idle",
      activity: "Disponibile",
      model: bot.model ?? launch.command,
      agent: launch.agentId,
      mode: "bot",
      task: "",
      lines: [{ kind: "note", text: `${launch.command} ${launch.args.join(" ")}` }],
      workspaceId: owner || "workspace",
    }))
    /* Narrowed to nothing, or the grid keeps showing whichever session was
       expanded and the one just started is off screen. */
    setWb((w) => ({ ...w, view: "code", focusedId: id, expandedId: undefined }))
    setStarting(false)
    void startProcess(id, launch.agentId, "", undefined, launch.args)
    return { id, index: mine.length + 1 }
  }

  /*
   * A runner's own sign-in, in a pane of its own: the browser flow and the
   * code to paste are the CLI's, and a terminal is where it expects them.
   */
  const openLoginSession = (runner: Runner) => {
    const agentId = runner.id === "claude" ? "claude-code" : runner.id
    if (!agentById(agentId) || runner.login.length === 0) return
    const owner = project()?.name
    const id = `n${Date.now()}-login-${++paneSequence}`
    setWb((w) => addPane(w, {
      id,
      title: `${runner.label} · accesso`,
      status: "idle",
      activity: "Disponibile",
      model: runner.command,
      agent: agentId,
      mode: "bot",
      task: "",
      lines: [{ kind: "note", text: `${runner.command} ${runner.login.join(" ")}` }],
      workspaceId: owner || "workspace",
    }))
    setWb((w) => ({ ...w, view: "code", focusedId: id, expandedId: undefined }))
    setStarting(false)
    void startProcess(id, agentId, "", undefined, [...runner.login])
  }

  const gridPanes = createPaneRenderer({
    wb,
    setWb,
    project,
    records,
    liveTerminals,
    isRunning,
    sessionFor: (id) => running.get(id),
    appendLine,
    close,
    saveFile: (id) => void saveFile(id),
    answerPermission,
    restart: (pane, line) => void reopen(pane, line),
    pickVideo,
    captureFrame,
    panels,
    announceToAll,
    pluginRuntime,
  })

  const paletteChord = createMemo(() => {
    const entry = DEFAULT_BINDINGS.find((binding) => binding.commandId === "palette.open")
    return entry ? formatChord(parseChord(entry.chord, platform), platform) : ""
  })

  /*
   * How much of the window the sidebar takes, so the bar's middle group can
   * centre on the sessions rather than on the whole window. Measured, not read
   * from state: the sidebar owns its width while it is being dragged.
   */
  const [sidebarPx, setSidebarPx] = createSignal(0)
  onMount(() => {
    const sidebar = document.querySelector<HTMLElement>('[data-component="ade-sidebar"]')
    if (!sidebar || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => setSidebarPx(sidebar.getBoundingClientRect().width))
    observer.observe(sidebar)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div data-component="ade-shell" data-theme={theme()}>
      {/* First, so it is over the workbench while the workbench is still
          half-built. It unmounts itself once its fade is done. */}
      <Splash visible={booting() !== undefined} status={booting()} onDismiss={dismissSplash} />

      <header
        data-slot="ade-bar"
        data-platform={isTauriDesktop() && isMacOS() ? "macos" : undefined}
        data-tauri-drag-region
        style={{ "--ade-bar-offset": `${sidebarPx()}px` }}
        onDblClick={(e) => {
          if (e.target === e.currentTarget) void adeWindowToggleMaximize()
        }}
      >
        {/* Three groups: who and where on the left, the navigation in the
            middle, the controls on the right. The middle one is centred on
            the sessions area — the window minus the sidebar — rather than on
            what is left over, so the section you are in does not move when a
            project name gets longer. */}
        <div data-slot="ade-bar-side" data-side="start">
          {/*
            The mark, not the word.
            It draws in `currentColor`, so the ink the bar spends on it
            follows the theme — which a pair of baked assets never managed.
            The name stays in the accessibility tree: the mark is decorative
            and the label is on the box around it.
          */}
          <Show when={!(isTauriDesktop() && isMacOS())}>
            <span data-slot="ade-brand" role="img" aria-label="ADE">
              {/*
                Concept 03: Molten Chrome Mercury (N).
                Continuous liquid metal ribbon with animated caustic sheen
                and floating mercury micro-droplets.
              */}
              <NikChromeLogo size={30} />
            </span>
          </Show>
          <ProjectBar project={project()} />
          <span data-slot="ade-count">{wb().panes.filter(p => !p.browserUrl && !p.plugin).length} sessioni</span>
        </div>

        <div data-slot="ade-bar-center">
        {/* A segmented control rather than loose chips: with four sections
            the set is the navigation, and it has to read as one object with
            one selection — not as four independent toggles. */}
        <div data-slot="ade-views" role="tablist" aria-label="Sezioni">
          <For each={ADE_VIEWS}>
            {(view) => (
              <button
                type="button"
                role="tab"
                aria-selected={wb().view === view}
                data-slot="ade-view-tab"
                data-active={wb().view === view ? "true" : undefined}
                onClick={() => setWb(w => ({ ...w, view }))}
              >
                {ADE_VIEW_LABELS[view]}
              </button>
            )}
          </For>
        </div>
        {/* The palette, next to the sections rather than in the middle of the
            bar: it is navigation too — the way to reach what the four tabs do
            not show — and it belongs with the thing it extends. Reduced to its
            icon so the group stays one object; the chord is in the tooltip,
            which is where a shortcut for a control this small belongs. */}
        <button
          type="button"
          data-slot="ade-icon"
          data-action="palette"
          onClick={() => setPaletteOpen(true)}
          aria-label="Cerca o esegui"
          title={`Cerca o esegui  ${paletteChord()}`}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2L14 14" stroke-linecap="round" />
          </svg>
        </button>
        </div>

        <div data-slot="ade-bar-side" data-side="end">

        {/*
          The column chips used to sit here — a label and five buttons, shown
          only in `code`. They were configuration parked among the verbs: a
          decision taken once and then left alone, holding a permanent seat in
          a bar where every other control does something to the project right
          now. They live in Impostazioni › Codice, with room to say what
          "auto" means. See `GridSection`.
        */}
        {/*
          One control: the orb.

          The assistant and dictation are two features — both always available,
          neither a position of a switch the other has to be turned off for —
          but they share one microphone, and the bar shows what the microphone
          is doing. Two lit controls for one open microphone was two answers to
          one question. Pressing the orb opens it for whichever feature is the
          default; the two chords open the one they name; and the orb says
          which has it, without ever turning into a microphone glyph.

          There used to be a second button here that opened the voice panel.
          It was the third way into the same screen — the sidebar has the gear,
          and three of the views link to it — and it put a configuration
          control in the middle of the toolbar's verbs.
        */}
        <div
          data-slot="ade-voice-controls"
          data-voice-mode={voiceEngine.isRunning() ? voiceEngine.activeMode() : undefined}
          title={voiceAvailable ? undefined : "Riconoscimento vocale non supportato da questo browser"}
        >
          <VoiceOrb engine={voiceEngine} class={voiceAvailable ? undefined : "disabled"} />
        </div>

        {/* Everything that opens a pane, behind one mark.
            One button per kind worked while there were two; with a video
            player, and an emulator and a 3D viewer behind it, the bar would
            become a row of verbs competing with the navigation beside it. */}
        <Show when={showsNewPane(wb().view)}>
          <div data-slot="ade-menu-anchor">
            <button
              type="button"
              data-slot="ade-icon"
              data-action="new-pane"
              data-open={newPaneOpen() ? "true" : undefined}
              aria-haspopup="menu"
              aria-expanded={newPaneOpen()}
              onClick={() => setNewPaneOpen((open) => !open)}
              aria-label="Nuovo pannello"
              title="Nuovo pannello"
            >
              {/* Four frames: the grid this button adds to. */}
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">
                <rect x="2" y="2" width="5" height="5" rx="1.2" />
                <rect x="9" y="2" width="5" height="5" rx="1.2" />
                <rect x="2" y="9" width="5" height="5" rx="1.2" />
                <rect x="9" y="9" width="5" height="5" rx="1.2" />
              </svg>
            </button>

            <Show when={newPaneOpen()}>
              <div data-slot="ade-menu" role="menu" aria-label="Nuovo pannello">
                <For each={NEW_PANE_ITEMS}>
                  {(item) => (
                    <button
                      type="button"
                      role="menuitem"
                      data-slot="ade-menu-item"
                      onClick={() => {
                        setNewPaneOpen(false)
                        void runCommand(item.commandId)
                      }}
                    >
                      <span data-slot="ade-menu-glyph" aria-hidden="true">
                        <NewPaneGlyph kind={item.glyph} />
                      </span>
                      <span data-slot="ade-menu-text">
                        <span data-slot="ade-menu-label">{item.label}</span>
                        <span data-slot="ade-menu-hint">{item.hint}</span>
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        {/* On macOS the traffic lights hold the left edge, so the mark takes
            the place the window controls have elsewhere. */}
        <Show when={isTauriDesktop() && isMacOS()}>
          <span data-slot="ade-brand" data-place="end" role="img" aria-label="ADE">
            <NikChromeLogo size={30} />
          </span>
        </Show>

        <Show when={isTauriDesktop() && !isMacOS()}>
          <div data-slot="ade-window-controls" aria-label="Controlli finestra">
            <button
              type="button"
              data-slot="ade-win-btn"
              data-win="minimize"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                void adeWindowMinimize()
              }}
              title="Riduci a icona"
              aria-label="Riduci a icona"
            >
              <svg viewBox="0 0 10 1" width="10" height="1" style={{ "pointer-events": "none" }}>
                <rect width="10" height="1" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              data-slot="ade-win-btn"
              data-win="maximize"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                void adeWindowToggleMaximize()
              }}
              title="Ingrandisci / Ripristina"
              aria-label="Ingrandisci o ripristina"
            >
              <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1" style={{ "pointer-events": "none" }}>
                <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
              </svg>
            </button>
            <button
              type="button"
              data-slot="ade-win-btn"
              data-win="close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                void adeWindowClose()
              }}
              title="Chiudi"
              aria-label="Chiudi"
            >
              <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.2" style={{ "pointer-events": "none" }}>
                <path d="M1 1L9 9M9 1L1 9" />
              </svg>
            </button>
          </div>
        </Show>

        </div>
      </header>

      <Show when={voiceNotice()}>
        <div
          role="alert"
          data-slot="ade-voice-notice"
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            padding: "var(--ade-space-2) var(--ade-space-6)",
            background: "var(--ade-working-bg)",
            color: "var(--ade-working)",
            "border-bottom": "1px solid var(--ade-border)",
            "font-size": "var(--ade-font-sm)",
            "font-family": "var(--ade-sans)",
          }}
        >
          <span>{voiceNotice()}</span>
          <button
            type="button"
            style={{
              background: "transparent",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              "font-size": "var(--ade-font-sm)",
              padding: "0 var(--ade-space-2)",
            }}
            onClick={() => setVoiceNotice(undefined)}
            aria-label="Chiudi avviso"
          >
            ✕
          </button>
        </div>
      </Show>

      <div data-slot="ade-body">
        <Sidebar
          workspaces={workspaces()}
          selectedSessionId={wb().focusedId}
          /* The bot section's roster lives in this column, where the sessions
             and files are otherwise: one list on the left, not two. The foot
             stays: the screenshots are what a bot will be shown. */
          content={
            wb().view === "bot" ? (
              <BotsRoster {...(project()?.root ? { projectRoot: project()!.root } : {})} />
            ) : undefined
          }
          onSelectSession={(id) => void openSession(id)}
          /* No picker in the browser harness, so no button that could not work. */
          onAddProject={hasHost() ? () => void addProject() : undefined}
          onAddRemote={hasHost() ? () => setRemoteOpen(true) : undefined}
          onSelectProject={(id) => void switchProject(id)}
          onNewSession={() => setStarting(true)}
          project={project()}
          searchFiles={hasHost() ? searchProjectFiles : undefined}
          selectedFilePath={selectedFile()}
          onSelectFile={(path) => void openFile(path)}
          onOpenSettings={() => setVoiceSettingsOpen(true)}
          bottom={
            <ShotTray
              shots={shotSource.shots()}
              load={shotSource.load}
              onDismiss={shotSource.dismiss}
              onDelete={(path) => void shotSource.remove(path)}
            />
          }
          /*
           * The theme and the bell, down beside the gear.
           *
           * They were in the top bar, among the buttons that open a pane,
           * start a session or search the project. Neither of them does
           * anything to the project: one is how the window looks and the
           * other is what it has already told you. Down here they sit with
           * the only other control of the same kind.
           */
          footerActions={
            <>
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

              {/* The bell, and the only place a notice survives being missed.
                  `data-drop="up"` because at the foot of the column there is
                  nothing below the button to hang a menu on. */}
              <div data-slot="ade-menu-anchor" data-drop="up">
                <button
                  type="button"
                  data-slot="ade-icon"
                  data-action="notifications"
                  data-tone={bellTone(notices())}
                  aria-haspopup="menu"
                  aria-expanded={noticesOpen()}
                  onClick={() => {
                    const opening = !noticesOpen()
                    setNoticesOpen(opening)
                    // Opening is reading: they are one line each and all on screen.
                    if (opening) setNotices((list) => markAllRead(list))
                  }}
                  aria-label={
                    unreadCount(notices()) > 0
                      ? `Notifiche, ${unreadCount(notices())} da leggere`
                      : "Notifiche"
                  }
                  title="Notifiche"
                >
                  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">
                    <path d="M8 2.2a3.8 3.8 0 0 1 3.8 3.8v2.2l1 2H3.2l1-2V6A3.8 3.8 0 0 1 8 2.2z" stroke-linejoin="round" />
                    <path d="M6.6 12.6a1.5 1.5 0 0 0 2.8 0" stroke-linecap="round" />
                  </svg>
                  <Show when={unreadCount(notices()) > 0}>
                    <span data-slot="ade-badge">{Math.min(unreadCount(notices()), 99)}</span>
                  </Show>
                </button>

                <Show when={noticesOpen()}>
                  <div data-slot="ade-menu" data-wide="true" role="menu" aria-label="Notifiche">
                    <Show
                      when={notices().length > 0}
                      fallback={<p data-slot="ade-menu-empty">Nessuna notifica.</p>}
                    >
                      <For each={notices()}>
                        {(notice) => (
                          <div data-slot="ade-notice-row" data-kind={notice.kind}>
                            <span data-slot="ade-notice-text">{notice.text}</span>
                            <Show when={notice.href}>
                              {(href) => (
                                <button
                                  type="button"
                                  data-slot="ade-notice-link"
                                  disabled={updating()}
                                  onClick={() => void installUpdate(href())}
                                >
                                  {updating() ? "Aggiornamento…" : "Aggiorna"}
                                </button>
                              )}
                            </Show>
                            <button
                              type="button"
                              data-slot="ade-notice-dismiss"
                              onClick={() => setNotices((list) => dismissNotice(list, notice.id))}
                              aria-label="Scarta"
                            >
                              ×
                            </button>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                </Show>
              </div>
            </>
          }
        />

        <main data-slot="ade-main">
          {/* Above the section rather than over it: these messages are about
              something that already happened, so they must not cover the
              thing the user is about to look at. Dismissed by hand, because a
              failed save that vanishes on a timer is a failed save nobody
              read. */}
          <Show when={notice()}>
            {(text) => (
              <div data-slot="ade-notice" role="status">
                <span data-slot="ade-notice-text">{text()}</span>
                <button
                  type="button"
                  data-slot="ade-notice-close"
                  onClick={() => setNotice(undefined)}
                  aria-label="Chiudi l'avviso"
                >
                  ✕
                </button>
              </div>
            )}
          </Show>

          <Show when={wb().view === "agent"}>
            <AgentConsole
              history={voiceEngine.history()}
              running={voiceEngine.isRunning()}
              status={voiceEngine.status()}
              partial={voiceEngine.partialTranscript()}
              canPlan={Boolean(voiceSettings().openRouterApiKey)}
              onSubmit={(text) => void voiceEngine.submitText(text)}
              onToggleMic={() => void voiceEngine.toggle()}
              onOpenSettings={() => setVoiceSettingsOpen(true)}
            />
          </Show>

          <Show when={wb().view === "chat"}>
            {/* The same credential the assistant uses. Asking for it twice is
                a way to get one of the two wrong. */}
            <Chat
              apiKey={voiceSettings().openRouterApiKey ?? ""}
              onOpenSettings={() => setVoiceSettingsOpen(true)}
            />
          </Show>

          <Show when={wb().view === "bot"}>
            {/* A bot is a nikcli agent, so there is no key to ask for and no
                roster of ADE's own: the section reads the files nikcli reads,
                and starting one is the session the user would start. */}
            <BotsMain
              {...(project()?.root ? { projectRoot: project()!.root } : {})}
              onLaunch={(bot) => openBotSession(bot)}
              onOpenFile={(path) => void openFile(path)}
            />
          </Show>

          <Show when={wb().view === "code"}>
            {/* Without a project there is nothing to run an agent in, and in the
                browser there is no way to run one at all. Offering the launch
                screen there would be offering a button that cannot work. */}
            <Show
              when={project()}
              fallback={<EmptyProject hasHost={hasHost()} onOpenProject={() => runCommand("project.open")} />}
            >
              {/* Counted within the project, not across all of them: standing
                  in a project with no sessions must offer the launch screen,
                  even while another project's sessions are still running. */}
              <Show
                when={gridPanes().length > 0 && !starting()}
                fallback={
                  <SessionNew
                    workspace={project()?.name || "workspace"}
                    path={project()?.root || ""}
                    /* Cancelling is only offered when there is something to go
                       back to; on an empty workbench it would lead nowhere. */
                    onClose={gridPanes().length > 0 ? () => setStarting(false) : undefined}
                    onLaunch={(input) => launchSessions(input)}
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

      <RemoteSpaceDialog
        open={remoteOpen()}
        onClose={() => setRemoteOpen(false)}
        onConnect={(target) => void addRemoteSpace(target)}
      />

      <CommandPalette
        open={paletteOpen()}
        commands={allCommands()}
        onRun={runCommand}
        onClose={() => setPaletteOpen(false)}
        platform={platform}
        emptyLabel="Nessun comando trovato."
      />

      {/*
        ADE's one settings panel.
        The plugins used to be a card in the sidebar, between the file tree
        and the screenshot tray — a list of what is loaded, sitting in the
        column meant for projects and files. They are configuration, so they
        are here, in the same rail as everything else configurable. One
        panel, one gear, one answer to "where are the settings".
      */}
      <Show when={voiceSettingsOpen()}>
        <VoiceSettingsPanel
          engine={voiceEngine}
          settings={voiceSettings()}
          onChange={handleVoiceSettingsChange}
          onClose={() => setVoiceSettingsOpen(false)}
          existingBindings={bindings}
          title="Impostazioni"
          subtitle="Voce, routine, bot, codice, MCP, plugin e competenze"
          /*
           * Two headings, because the rail is now two lists.
           * Six voice screens followed by six of ADE's own, unbroken, gave
           * no clue where the microphone stopped and the application began.
           */
          builtInGroup="Voce"
          extraGroup="ADE"
          extraSections={[
            {
              id: "set-sec-routine",
              label: "Routine",
              glyph: "↻",
              render: () => <RoutineSection />,
            },
            {
              id: "set-sec-bot",
              label: "Bot",
              glyph: "◍",
              // The project, so the list holds the bots that belong to it as
              // well as the global ones — which is what nikcli would see.
              render: () => <BotSection {...(project()?.root ? { projectRoot: project()!.root } : {})} />,
            },
            {
              /*
               * "Codice" is the coding view's own settings: how its grid is
               * laid out, and how a session finds its way back to the
               * conversation it was having. Both are about the panes, and
               * the panes are what the `code` view is.
               */
              id: "set-sec-code",
              label: "Codice",
              glyph: "⌗",
              value: String(Object.values(hookStates()).filter((state) => state.installed).length),
              render: () => (
                <>
                  <GridSection
                    columns={wb().pinnedColumns}
                    onChange={(columns) => setWb((w) => setColumns(w, columns))}
                  />
                  <AgentHooksSection
                    host={hookHost()}
                    states={hookStates()}
                    onChanged={() => void refreshHooks()}
                  />
                </>
              ),
            },
            {
              id: "set-sec-provider",
              label: "Provider",
              glyph: "⚿",
              render: () => <ProviderSection onLogin={(runner) => openLoginSession(runner)} />,
            },
            {
              id: "set-sec-mcp",
              label: "MCP",
              glyph: "⇄",
              render: () => <McpSection />,
            },
            {
              id: "set-sec-plugins",
              label: "Plugin",
              glyph: "⊞",
              value: String(pluginRuntime.registry.sections().length),
              render: () => (
                <>
                  <div data-slot="section-head">
                    <h3 data-slot="section-title" tabIndex={-1}>
                      Plugin
                    </h3>
                    <p data-slot="section-desc">Cosa è caricato, e cosa ciascuno aggiunge ad ADE.</p>
                  </div>
                  <Show
                    when={pluginRuntime.registry.sections().length > 0}
                    fallback={<p data-slot="section-desc">Nessun plugin caricato.</p>}
                  >
                    <For each={pluginRuntime.registry.sections()}>
                      {(section) => (
                        <PluginSection title={section.title} render={() => section.render({})} />
                      )}
                    </For>
                  </Show>
                </>
              ),
            },
            {
              id: "set-sec-skills",
              label: "Strumenti",
              glyph: "✦",
              render: () => <SkillsSection {...(project()?.root ? { projectRoot: project()!.root } : {})} />,
            },
          ]}
        />
      </Show>

      {/*
        Last in the shell, so it paints over the grid without being inside it.
        The target is named rather than implied: dictation lands in the focused
        pane, and a widget that transcribed into a session the user had stopped
        looking at would be a surprise every time.
      */}
      <VoiceHud
        engine={voiceEngine}
        target={(() => {
          const focused = wb().panes.find((pane) => pane.id === wb().focusedId)
          return focused?.title
        })()}
        onCycleTarget={() => {
          const sessionPanes = wb().panes.filter((p) => !p.browserUrl && !p.plugin && !p.filePath && !p.videoPath)
          if (sessionPanes.length <= 1) return
          const currentIndex = sessionPanes.findIndex((p) => p.id === wb().focusedId)
          const nextIndex = (currentIndex + 1) % sessionPanes.length
          const nextPane = sessionPanes[nextIndex]
          if (nextPane) {
            setWb((w) => ({ ...w, focusedId: nextPane.id }))
          }
        }}
        onOpenSettings={() => setVoiceSettingsOpen(true)}
      />
    </div>
  )
}

/**
 * The mark for one entry of the multiframe menu.
 *
 * Drawn here rather than in `new-pane.ts` because a glyph is a component and
 * that module has to stay importable under `bun test`, where a `.tsx` is not.
 */
function NewPaneGlyph(props: { kind: NewPaneItem["glyph"] }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">
      <Show when={props.kind === "session"}>
        <rect x="1.8" y="3" width="12.4" height="10" rx="1.6" />
        <path d="M4.4 6.6l2 1.9-2 1.9M8.4 10.4h3.2" stroke-linecap="round" stroke-linejoin="round" />
      </Show>
      <Show when={props.kind === "browser"}>
        <rect x="1.8" y="3" width="12.4" height="10" rx="1.6" />
        <path d="M1.8 6.2h12.4M4 4.6h.01M5.9 4.6h.01" stroke-linecap="round" />
      </Show>
      <Show when={props.kind === "video"}>
        <rect x="1.8" y="3.4" width="12.4" height="9.2" rx="1.6" />
        <path d="M6.6 6.4l3.8 2.2-3.8 2.2z" stroke-linejoin="round" />
      </Show>
    </svg>
  )
}
