/**
 * What a plugin is shown of ADE, and what changed in it.
 *
 * `pluginPicture` is a pure function of the workbench: the sessions that are really there, each with the state its own header shows
 * (`resolvePaneState`, never a second opinion), and the projects they belong to. `restrict` cuts it to what the plugin was granted: a plugin
 * without `sessions:read` gets nothing about sessions, not even how many, and one without `projects:read` no project.
 *
 * Only titles, states, kinds, project names and counters go in. A transcript or a path never does, and a project is named by an id that is a
 * hash of its folder with a salt of the plugin's own: two plugins cannot compare notes, and one cannot test a guess of a path against it.
 */

import { resolvePaneState, type PaneState, type PaneStatus } from "../grid/pane-state"
import { pathEquals } from "../host/path"
import type { SessionQuota } from "../session/quota"
import type { ProjectRef } from "../surface/pane-project"
import { isPanelPane, type Pane } from "../surface/state"
import type { Permission, ProjectInfo, SessionEvent, SessionInfo, SessionsSnapshot } from "./api"
import { sha256Hex } from "./hash"

/** A fresh salt for a plugin: 16 random bytes as hex. ADE keeps it (`grants.ts`), the plugin never sees it. */
export function newSalt(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** The id of a project for the plugin whose salt this is: its folder when it has one (case and slashes ignored), else its name. */
export function projectId(salt: string, project: { name: string; root?: string }): string {
  const key = project.root ? `r:${project.root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}` : `n:${project.name}`
  return `p${sha256Hex(`${salt}\n${key}`).slice(0, 16)}`
}

/** What ADE knows about a pane that the pane itself does not carry: whether its process is there, what it asks. */
export interface PaneFacts {
  /** The activity the header shows: the agent's report, or `suspended`. */
  activity?: string
  /** No process behind the pane any more. */
  exited?: boolean
  /** The agent has asked the user something (a permission prompt is standing). */
  hasActions?: boolean
  quota?: SessionQuota
}

type PicturePane = Pick<
  Pane,
  "id" | "title" | "status" | "mode" | "agent" | "model" | "workspaceId" | "projectRoot" | "activity" | "suspended"
> &
  Partial<Pick<Pane, "browserUrl" | "filePath" | "videoPath" | "modelPath" | "appUrl" | "plugin" | "framePlugin">>

/** A pane that is a session with an agent, not a file, a browser or another panel. */
export function isSession(pane: PicturePane): boolean {
  return !isPanelPane({ ...pane, mode: pane.mode ?? "" }) && Boolean(pane.agent ?? pane.model)
}

/** The state the pane's header shows for it: the same function, fed the same things. */
export function paneState(pane: Pick<PicturePane, "status" | "activity" | "suspended">, facts: PaneFacts): PaneState {
  return resolvePaneState({
    status: pane.status as PaneStatus,
    activity: pane.suspended ? "suspended" : (facts.activity ?? pane.activity),
    ...(facts.exited !== undefined ? { exited: facts.exited } : {}),
    ...(facts.hasActions !== undefined ? { hasActions: facts.hasActions } : {}),
    ...(facts.quota ? { quota: facts.quota } : {}),
  })
}

/** Everything ADE could show a plugin; what a plugin is shown is `restrict(picture, granted)`. */
export interface Picture {
  at: number
  sessions: SessionInfo[]
  projects: ProjectInfo[]
  /** Decisions waiting for the user. */
  decisions: number
}

export interface PictureInput {
  panes: readonly PicturePane[]
  /** The project open in ADE, which is always listed. */
  open?: ProjectRef
  facts: (pane: PicturePane) => PaneFacts
  decisions: number
  now: number
  /** The plugin's own salt (`newSalt`). */
  salt: string
  /** The last picture: a session that has not changed state keeps its `since`. */
  previous?: Picture
}

export function pluginPicture(input: PictureInput): Picture {
  const sessions = input.panes.filter(isSession)

  // One project per folder that is open in ADE or has a session in it, in the order they appear.
  const found: { name: string; root?: string }[] = []
  const projectOf = (pane: { workspaceId?: string; projectRoot?: string }): { name: string; root?: string } => {
    const known = found.find((project) =>
      pane.projectRoot && project.root ? pathEquals(pane.projectRoot, project.root) : pane.workspaceId === project.name,
    )
    if (known) return known
    const created = {
      name: pane.workspaceId || (pane.projectRoot ? pane.projectRoot.split(/[\\/]/).filter(Boolean).pop()! : "—"),
      ...(pane.projectRoot ? { root: pane.projectRoot } : {}),
    }
    found.push(created)
    return created
  }
  if (input.open) found.push({ name: input.open.name, root: input.open.root })
  const owners = sessions.map((pane) => ({ pane, project: projectOf(pane) }))

  const before = new Map((input.previous?.sessions ?? []).map((session) => [session.paneId, session]))
  return {
    at: input.now,
    projects: found.map((project) => ({ id: projectId(input.salt, project), name: project.name })),
    sessions: owners.map(({ pane, project }) => {
      const state = paneState(pane, input.facts(pane))
      const earlier = before.get(pane.id)
      return {
        paneId: pane.id,
        title: pane.title,
        kind: pane.agent ?? pane.model,
        project: projectId(input.salt, project),
        state,
        since: earlier && earlier.state === state ? earlier.since : input.now,
      }
    }),
    decisions: input.decisions,
  }
}

/** What a plugin with these permissions is shown: each part only if it was granted. */
export interface Shown {
  at: number
  sessions?: SessionInfo[]
  projects?: ProjectInfo[]
  decisions?: number
}

export function restrict(picture: Picture, granted: readonly Permission[]): Shown {
  return {
    at: picture.at,
    ...(granted.includes("sessions:read") ? { sessions: picture.sessions } : {}),
    ...(granted.includes("projects:read") ? { projects: picture.projects } : {}),
    ...(granted.includes("decisions:count") ? { decisions: picture.decisions } : {}),
  }
}

export function sessionsOf(shown: Shown): SessionsSnapshot | undefined {
  return shown.sessions ? { at: shown.at, sessions: shown.sessions } : undefined
}

/** What happened to the sessions between two pictures, in the order a plugin should apply it. */
export function diffSessions(previous: SessionInfo[], next: SessionInfo[], at: number): SessionEvent[] {
  const events: SessionEvent[] = []
  const old = new Map(previous.map((session) => [session.paneId, session]))
  const now = new Map(next.map((session) => [session.paneId, session]))
  for (const session of next) if (!old.has(session.paneId)) events.push({ type: "open", session })
  for (const session of next) {
    const earlier = old.get(session.paneId)
    if (earlier && earlier.state !== session.state) events.push({ type: "state", paneId: session.paneId, state: session.state, at })
  }
  for (const session of previous) if (!now.has(session.paneId)) events.push({ type: "close", session })
  return events
}

/**
 * Whether something the events cannot say has changed (a title, a kind, a project): then the whole snapshot is sent again instead of the
 * events, so a plugin never shows a name that ADE no longer uses.
 */
export function needsResync(previous: SessionInfo[], next: SessionInfo[]): boolean {
  const old = new Map(previous.map((session) => [session.paneId, session]))
  return next.some((session) => {
    const earlier = old.get(session.paneId)
    return earlier !== undefined && (earlier.title !== session.title || earlier.kind !== session.kind || earlier.project !== session.project)
  })
}

export function sameProjects(a: readonly ProjectInfo[], b: readonly ProjectInfo[]): boolean {
  return a.length === b.length && a.every((project, index) => project.id === b[index]!.id && project.name === b[index]!.name)
}
