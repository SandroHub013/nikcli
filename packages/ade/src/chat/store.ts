/**
 * The chat's state, outside any component (C2).
 *
 * One store per window, made on first use and never disposed with a view:
 * `chat.tsx` reads it and calls it, and leaving the Chat section unmounts the
 * view but not the stream, so an answer keeps arriving. Nothing is called
 * before `open`: making the store costs no request (C9).
 *
 * Opening a folder admits it (`connection.ts`), then keeps its event stream
 * (`stream.ts`) and loads what the chat shows:
 * - the stream first, then the sessions and their status once the server
 *   says `server.connected`, so no event falls between the two;
 * - after every reconnection the same load again, and the messages of the
 *   sessions being shown, since events lost in the gap do not come back;
 * - a stream silent for `SILENCE_MS` (two and a half heartbeats), closed, or
 *   ended with `server.error` (the server drops a client too far behind) is
 *   reopened after a wait that grows to 30 s (`BACKOFF_MS`);
 * - a refusal (the project no longer trusted, a 401 or 403) is final: status
 *   `refused` with its reason, and only a new `open` tries again.
 *
 * Opening another folder closes this one's stream and starts from nothing:
 * two folders never mix. An answer running in the folder left is not
 * stopped: it is the server's, and it is found finished on return (C2
 * review).
 */

import type { Message, Part, PermissionRequest, QuestionRequest, Session, SessionStatus } from "@nikcli-ai/sdk/httpapi"
import { createStore, reconcile, type SetStoreFunction } from "solid-js/store"
import { appChatConnectionDeps, isChatRefused, openChat, type ChatConnection } from "./connection"
import { applyChatEvent, emptyChatData, type ChatData, type ChatEvent, type ChatEventOutcome } from "./events"
import { readEvents, StreamRefused } from "./stream"

export type ChatStatus = "idle" | "admitting" | "connecting" | "live" | "retrying" | "refused"

/** Read-only for the view: a Solid store, changed only here. */
export interface ChatState {
  directory?: string
  status: ChatStatus
  /** Why the chat is `refused`, when it said. */
  problem?: string
  data: ChatData
}

/** A model as the server names it. Always sent: the server's own default may be a paid one. */
export interface ModelRef {
  readonly providerID: string
  readonly modelID: string
}

export interface ChatStore {
  readonly state: ChatState
  /** Admits `directory` and keeps its stream; the folder already open is left as it is. */
  open(directory: string): Promise<void>
  /** Stops the stream. What was loaded stays readable until the next `open`. */
  close(): void
  /** Sends `text` to `sessionID`, or to a new session; the id it went to. The answer comes as events. */
  send(sessionID: string | undefined, text: string, model: ModelRef): Promise<string>
  /** Stops the answer running in `sessionID` on the server. */
  abort(sessionID: string): Promise<void>
  /** Loads a session's messages, and keeps loading them after every reconnection. */
  loadMessages(sessionID: string): Promise<void>
}

export interface ChatStoreDeps {
  readonly connect: (directory: string) => Promise<ChatConnection>
  readonly silenceMs?: number
  readonly backoffMs?: readonly number[]
  /** Waits `ms`, or less if `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly random?: () => number
}

/** Two and a half of the server's 30 s heartbeats. */
export const SILENCE_MS = 75_000
export const BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
/** How many messages of a session are loaded. */
const MESSAGE_LIMIT = 100

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function bySession<T extends { id: string; sessionID: string }>(list: readonly T[]): Record<string, T[]> {
  const grouped: Record<string, T[]> = {}
  for (const item of list) (grouped[item.sessionID] ??= []).push(item)
  for (const items of Object.values(grouped)) items.sort(byId)
  return grouped
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

type Open = Extract<ChatConnection, { ok: true }>

export function createChatStore(deps: ChatStoreDeps): ChatStore {
  const silenceMs = deps.silenceMs ?? SILENCE_MS
  const backoff = deps.backoffMs ?? BACKOFF_MS
  const sleep = deps.sleep ?? wait
  const random = deps.random ?? Math.random

  const [state, setState] = createStore<ChatState>({ status: "idle", data: emptyChatData() })
  const setData = ((...args: unknown[]) => (setState as (...a: unknown[]) => void)("data", ...args)) as SetStoreFunction<ChatData>

  /** Bumped by every `open` and `close`: work of an older one stops touching the state. */
  let generation = 0
  let current: { connection: Open; stop: AbortController } | undefined
  /** Sessions whose messages are shown, reloaded after a reconnection. */
  const watched = new Set<string>()
  /** One list per load in flight: the events that arrive while it runs, applied again over what it loaded. */
  const arriving = new Set<ChatEvent[]>()

  /** Applies an event; one the reducer cannot read is skipped, not a reason to reconnect. */
  function apply(event: ChatEvent): ChatEventOutcome {
    try {
      return applyChatEvent(event, state.data, setData)
    } catch {
      return undefined
    }
  }

  const refuse = (mine: number, error: unknown) => {
    if (mine !== generation) return
    setState({ status: "refused", problem: error instanceof Error ? error.message : undefined })
    current?.stop.abort()
  }

  async function fetchMessages(connection: Open, sessionID: string, mine: number) {
    const result = await connection.client.session.messages({ sessionID, limit: MESSAGE_LIMIT })
    if (mine !== generation) return
    const list = (result.data ?? []) as unknown as { info: Message; parts: Part[] }[]
    setData("message", sessionID, reconcile(list.map((m) => m.info).sort(byId), { key: "id" }))
    for (const message of list) setData("part", message.info.id, reconcile([...message.parts].sort(byId), { key: "id" }))
  }

  /** The folder's sessions, their status and the watched messages; false when it did not load. */
  async function bootstrap(connection: Open, mine: number): Promise<boolean> {
    // What the server lists was read at some point during the fetch: an event
    // that came meanwhile (an answer starting) may be newer, so it goes again on top.
    const meanwhile: ChatEvent[] = []
    arriving.add(meanwhile)
    try {
      const [sessions, status, permissions, questions] = await Promise.all([
        connection.client.session.list({}),
        connection.client.session.status(),
        connection.client.permission.list(),
        connection.client.question.list(),
      ])
      if (mine !== generation) return false
      setData("session", reconcile([...((sessions.data ?? []) as unknown as Session[])].sort(byId), { key: "id" }))
      setData("session_status", reconcile((status.data ?? {}) as unknown as Record<string, SessionStatus>))
      // Requests still waiting: one asked while the stream was down is not sent again.
      setData("permission", reconcile(bySession((permissions.data ?? []) as unknown as PermissionRequest[])))
      setData("question", reconcile(bySession((questions.data ?? []) as unknown as QuestionRequest[])))
      await Promise.all([...watched].map((id) => fetchMessages(connection, id, mine)))
      if (mine !== generation) return false
      for (const event of meanwhile) apply(event)
      return true
    } catch (error) {
      if (isChatRefused(error)) refuse(mine, error)
      return false
    } finally {
      arriving.delete(meanwhile)
    }
  }

  async function run(connection: Open, mine: number, stopped: AbortSignal) {
    let attempt = 0
    while (mine === generation) {
      setState("status", attempt === 0 ? "connecting" : "retrying")
      const round = new AbortController()
      const stopRound = () => round.abort()
      stopped.addEventListener("abort", stopRound, { once: true })
      let silence: ReturnType<typeof setTimeout> | undefined
      const heard = () => {
        clearTimeout(silence)
        silence = setTimeout(stopRound, silenceMs)
      }
      try {
        heard()
        for await (const event of readEvents(connection.fetch, connection.directory, round.signal)) {
          if (mine !== generation) return
          heard()
          if (event.type === "server.connected") {
            void bootstrap(connection, mine).then((loaded) => {
              if (loaded && !round.signal.aborted) {
                setState("status", "live")
                attempt = 0
              } else if (!loaded) stopRound()
            })
            continue
          }
          // The server drops a client too far behind: what it missed is lost, so start over.
          if (event.type === "server.error") break
          for (const list of arriving) list.push(event)
          if (apply(event) === "resync") {
            void bootstrap(connection, mine).then((loaded) => loaded || stopRound())
          }
        }
      } catch (error) {
        if (mine !== generation) return
        if (isChatRefused(error) || error instanceof StreamRefused) return refuse(mine, error)
      } finally {
        clearTimeout(silence)
        stopped.removeEventListener("abort", stopRound)
        round.abort()
      }
      if (mine !== generation) return
      const delay = backoff[Math.min(attempt, backoff.length - 1)]! * (1 + 0.2 * random())
      attempt++
      setState("status", "retrying")
      await sleep(delay, stopped)
    }
  }

  function close() {
    generation++
    current?.stop.abort()
    current = undefined
    if (state.status !== "refused") setState("status", "idle")
  }

  function opened(): Open {
    if (!current) throw new Error("La chat non è aperta su una cartella.")
    return current.connection
  }

  return {
    state,
    async open(directory) {
      if (state.directory === directory && state.status !== "idle" && state.status !== "refused") return
      close()
      const mine = ++generation
      watched.clear()
      setState({ directory, status: "admitting", problem: undefined })
      setState("data", reconcile(emptyChatData()))
      let connection: Awaited<ReturnType<ChatStoreDeps["connect"]>>
      try {
        connection = await deps.connect(directory)
      } catch (error) {
        // The folder's files could not be read, or the server did not start:
        // refused, so that opening it again tries again.
        refuse(mine, error)
        return
      }
      if (mine !== generation) return
      if (!connection.ok) {
        setState({ status: "refused", problem: connection.problem })
        return
      }
      const stop = new AbortController()
      current = { connection, stop }
      void run(connection, mine, stop.signal)
    },
    close,
    async send(sessionID, text, model) {
      const connection = opened()
      const mine = generation
      let id = sessionID
      if (!id) {
        const created = await connection.client.session.create({})
        id = (created.data as unknown as Session).id
      }
      // Another folder opened meanwhile: the answer goes on in the first one, whose session it is.
      if (mine === generation) watched.add(id)
      await connection.client.session.promptAsync({ sessionID: id, parts: [{ type: "text", text }], model })
      return id
    },
    async abort(sessionID) {
      await opened().client.session.abort({ sessionID })
    },
    async loadMessages(sessionID) {
      watched.add(sessionID)
      if (current) await fetchMessages(current.connection, sessionID, generation)
    },
  }
}

let app: ChatStore | undefined

/** The window's chat: made on first use, with the Rust bridge and the Bots' trust in the project. */
export function appChatStore(): ChatStore {
  app ??= createChatStore({ connect: (directory) => openChat(directory, appChatConnectionDeps()) })
  return app
}
