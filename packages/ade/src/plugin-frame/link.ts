/**
 * ADE's end of the channel to a plugin.
 *
 * The panel gives it the port and the things ADE can do; it decides what goes over the port (`hello` when the port is made, the first picture
 * when the plugin says `ready`, then only what changed) and what comes back (a request, put through the cap, the schema and the permission of
 * `api.ts`, and about something the plugin was actually shown). Kept apart from the panel so all of it can be driven from a test with a fake
 * port.
 */

import {
  API_VERSION,
  authorize,
  createRateLimit,
  envelope,
  parseIncoming,
  storable,
  type Chord,
  type HelloInfo,
  type Permission,
  type RequestId,
  type ToPlugin,
} from "./api"
import { diffSessions, needsResync, restrict, sameProjects, sessionsOf, type Picture, type Shown } from "./bridge"

/** The part of a `MessagePort` the link uses. */
export interface LinkPort {
  postMessage(message: unknown): void
  close(): void
}

/** How long the document behind the port has to answer a probe before the port is closed. */
export const PROBE_MS = 1500

export interface LinkDeps {
  port: LinkPort
  /** What the plugin was granted: the permissions of its installed manifest that the user accepted. */
  granted: readonly Permission[]
  /** Language, theme and motion, as ADE has them now. */
  hello: () => HelloInfo
  /** The picture of ADE now; undefined while there is nothing to show. */
  picture: () => Picture | undefined
  /** ADE focuses the pane of a session; only ever called for one that the plugin was shown. */
  focusPane: (paneId: string) => void
  /** ADE reads the chord as one of its own bindings and runs it if it is navigation. `false`: it was not, and nothing ran. */
  runChord: (chord: Chord) => boolean
  /** The frame gives the focus back to ADE's own document. */
  releaseFocus: () => void
  /** The plugin's document, as it was left (`null` when it never wrote one). */
  storageGet: () => Promise<unknown>
  /** Replaces the plugin's document; the size was already checked. */
  storageSet: (json: string) => Promise<void>
  /** A message the plugin sent that was refused or dropped, and why. */
  ignored: (reason: string) => void
  /** Runs `run` after `ms`; the returned function cancels it. */
  schedule: (run: () => void, ms: number) => () => void
  now: () => number
  /** The probe went unanswered and the link closed itself: the document that owned the port is gone. */
  onDead?: () => void
  /** The plugin said `ready`: it is loaded and listening. */
  onReady?: () => void
}

export function createLink(deps: LinkDeps) {
  /** What the plugin has been shown; requests may only be about this. Absent until it says `ready`. */
  let shown: Shown | undefined
  let ready = false
  let paused = false
  let closed = false
  let probes = 0
  let asked: { id: number; cancel: () => void } | undefined
  const limit = createRateLimit(deps.now)
  const granted = [...deps.granted]

  const post = (message: ToPlugin) => {
    if (!closed) deps.port.postMessage(envelope(message))
  }

  /** The whole picture, restricted, as the plugin is now shown it. */
  const sendPicture = (): Shown | undefined => {
    const picture = deps.picture()
    if (!picture) return undefined
    shown = restrict(picture, granted)
    const sessions = sessionsOf(shown)
    if (sessions) post({ type: "sessions.snapshot", snapshot: sessions })
    if (shown.projects) post({ type: "projects", projects: shown.projects })
    if (shown.decisions !== undefined) post({ type: "decisions.count", count: shown.decisions })
    return shown
  }

  const ok = (id: RequestId | undefined, value: unknown = null) => {
    if (id !== undefined) post({ type: "reply", id, ok: true, value })
  }
  const fail = (id: RequestId | undefined, error: string) => {
    deps.ignored(error)
    post(id === undefined ? { type: "error", error } : { type: "reply", id, ok: false, error })
  }

  return {
    /** The port was made: the plugin is told what it is, and what it may. */
    start() {
      post({ type: "hello", api: API_VERSION, granted, ...deps.hello() })
    },

    /** A message arrived on the port. */
    receive(data: unknown) {
      if (closed) return
      const verdict = limit.admit()
      if (verdict !== "ok") {
        if (verdict === "first-drop") deps.ignored("troppi messaggi: oltre 50 al secondo si scartano")
        return
      }
      const parsed = parseIncoming(data)
      if (!parsed.ok) return fail(parsed.id, parsed.reason)
      const { incoming } = parsed
      if (incoming.kind === "pong") {
        // Only the answer to the probe that is waiting counts: an old or invented id is nothing.
        if (asked?.id === incoming.id) {
          asked.cancel()
          asked = undefined
        }
        return
      }
      if (incoming.kind === "ready") {
        ready = true
        deps.onReady?.()
        if (!paused) sendPicture()
        return
      }

      const { id, request } = incoming
      const denied = authorize(request.name, granted)
      if (denied) return fail(id, denied)

      switch (request.name) {
        case "sessions.snapshot":
        case "projects":
        case "decisions.count": {
          // Answered from the picture as it is now, and what the reply carries is what the plugin has been shown of it from now on: only
          // that part, so a count asked for does not make sessions it never received into ones it may focus.
          const picture = deps.picture()
          if (!picture) return fail(id, "niente da mostrare")
          const current = restrict(picture, granted)
          shown = { ...(shown ?? { at: current.at }), at: current.at }
          if (request.name === "sessions.snapshot") {
            shown.sessions = current.sessions
            return ok(id, sessionsOf(current))
          }
          if (request.name === "projects") {
            shown.projects = current.projects
            return ok(id, current.projects ?? [])
          }
          shown.decisions = current.decisions
          return ok(id, current.decisions ?? 0)
        }
        case "pane.focus": {
          if (!shown?.sessions?.some((session) => session.paneId === request.paneId))
            return fail(id, `pane.focus: sessione sconosciuta ${request.paneId.slice(0, 40)}`)
          deps.focusPane(request.paneId)
          return ok(id)
        }
        case "command.run": {
          if (!deps.runChord(request.chord)) return fail(id, "command.run: non è un comando di navigazione")
          return ok(id)
        }
        case "focus.release":
          deps.releaseFocus()
          return ok(id)
        case "storage.get":
          return void deps.storageGet().then(
            (value) => ok(id, value),
            (error) => fail(id, `storage.get: ${describe(error)}`),
          )
        case "storage.set": {
          const stored = storable(request.value)
          if (!stored.ok) return fail(id, `storage.set: ${stored.reason}`)
          return void deps.storageSet(stored.json).then(
            () => ok(id),
            (error) => fail(id, `storage.set: ${describe(error)}`),
          )
        }
      }
    },

    /** ADE changed: the plugin hears what is new. Nothing while it is paused (`resume` sends everything). */
    push() {
      if (closed || paused || !ready || !shown) return
      const picture = deps.picture()
      if (!picture) return
      const next = restrict(picture, granted)
      const before = shown
      shown = next
      if (next.sessions) {
        const old = before.sessions ?? []
        if (needsResync(old, next.sessions)) post({ type: "sessions.snapshot", snapshot: { at: next.at, sessions: next.sessions } })
        else for (const event of diffSessions(old, next.sessions, next.at)) post({ type: "sessions.event", event })
      }
      if (next.projects && !sameProjects(before.projects ?? [], next.projects)) post({ type: "projects", projects: next.projects })
      if (next.decisions !== undefined && next.decisions !== before.decisions) post({ type: "decisions.count", count: next.decisions })
    },

    /**
     * Asks the document at the other end of the port whether it is still there. A frame that navigated somewhere else took its document, and
     * the port with it, so nothing answers and the link closes; the plugin that reloaded or came back is met again by its own `hello`.
     */
    probe() {
      if (closed) return
      asked?.cancel()
      const id = ++probes
      post({ type: "ping", id })
      const cancel = deps.schedule(() => {
        if (asked?.id !== id) return
        asked = undefined
        this.close()
        deps.onDead?.()
      }, PROBE_MS)
      asked = { id, cancel }
    },

    pause() {
      if (closed || paused) return
      paused = true
      post({ type: "pause" })
    },

    /** The plugin draws again, and starts from the picture as it is now, not from where it stopped. */
    resume() {
      if (closed || !paused) return
      paused = false
      post({ type: "resume" })
      if (ready) sendPicture()
    },

    close() {
      closed = true
      asked?.cancel()
      asked = undefined
      shown = undefined
      deps.port.close()
    },

    /** What the plugin has been shown, for a test. */
    shown: () => shown,
  }
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}
