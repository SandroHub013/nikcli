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

import type {
  FilePartInput,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
} from "@nikcli-ai/sdk/httpapi"
import { createStore, reconcile, type SetStoreFunction } from "solid-js/store"
import { t } from "../i18n"
import {
  appChatConnectionDeps,
  isChatRefused,
  loadChatCatalog,
  openChat,
  type ChatCatalog,
  type ChatConnection,
} from "./connection"
import { applyChatEvent, emptyChatData, type ChatData, type ChatEvent, type ChatEventOutcome } from "./events"
import { CHAT_PERMISSION, hasChatRules } from "./rules"
import { insideProject, isEnvFile, pathOfFileUrl } from "./attachments"
import { catalogHasModel, serializeModelRef } from "./model"
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
  /**
   * Sends `text` to `sessionID`, or to a new session made with the chat's
   * permission rules (`rules.ts`); the id it went to. The answer comes as
   * events. A session made elsewhere is refused with `ForeignSession`.
   * `agent` is the one chosen in the chat; without it the server's default.
   * `files` go with the text; each must be a file of the open folder
   * (`attachments.ts`), or nothing is sent at all. Nor is anything sent for
   * a model the server's catalog does not have (`catalogHasModel`).
   */
  send(
    sessionID: string | undefined,
    text: string,
    model: ModelRef,
    agent?: string,
    files?: readonly FilePartInput[],
  ): Promise<string>
  /** The folder's files whose path matches `query`, relative to it, for `@`. */
  findFiles(query: string): Promise<string[]>
  /** Gives `sessionID` a new title; an empty one, or a session made elsewhere, is refused before anything is sent. */
  rename(sessionID: string, title: string): Promise<void>
  /** Answers a permission request: this once, or no. «Always» is not offered (C5). */
  replyPermission(requestID: string, reply: "once" | "reject"): Promise<void>
  /** Answers a question: for each of its questions, the labels chosen or typed. */
  answerQuestion(requestID: string, answers: readonly (readonly string[])[]): Promise<void>
  /** Declines a question: the model goes on without an answer. */
  rejectQuestion(requestID: string): Promise<void>
  /** Stops the answer running in `sessionID` on the server; one made elsewhere is refused with `ForeignSession`. */
  abort(sessionID: string): Promise<void>
  /** Loads a session's messages, and keeps loading them after every reconnection. */
  loadMessages(sessionID: string): Promise<void>
  /**
   * The providers, the agents and the configured model, through this folder's
   * own connection: the same admission, no second one (C4). Loaded once per
   * opening; a load that did not get the providers is tried again next time.
   */
  catalog(): Promise<ChatCatalog>
}

export interface ChatStoreDeps {
  readonly connect: (directory: string) => Promise<ChatConnection>
  readonly silenceMs?: number
  readonly backoffMs?: readonly number[]
  /** Waits `ms`, or less if `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly random?: () => number
  /**
   * Whether `path` is a file of the folder `root` once links and junctions
   * are followed: Rust's `chat_attachment_inside` (C6 review, MEDIO). `"ok"`,
   * or why not. Absent, every file is refused.
   */
  readonly checkAttachment?: (root: string, path: string) => Promise<AttachmentCheck>
}

export type AttachmentCheck = "ok" | "outside" | "notFile" | "env"

/** Rust's check, in the desktop app; anything that fails to answer is a no. */
export async function tauriAttachmentCheck(root: string, path: string): Promise<AttachmentCheck> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const answer = await invoke<string>("chat_attachment_inside", { root, path })
    return answer === "ok" || answer === "notFile" || answer === "env" ? answer : "outside"
  } catch {
    return "outside"
  }
}

/** A session the chat did not make: its permission rules are not the chat's, so nothing is sent to it. */
export class ForeignSession extends Error {
  override readonly name = "ForeignSession"
}

/** Two and a half of the server's 30 s heartbeats. */
export const SILENCE_MS = 75_000
export const BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
/** How many messages of a session are loaded. */
const MESSAGE_LIMIT = 100

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const TITLE_LIMIT = 60

/**
 * A new session's title: the first line of what was sent. Given at creation
 * because nikcli titles an untitled session with the provider's small model,
 * which ADE's server does not pin and which on OpenRouter is a paid one: a
 * session that already has a title is never titled by a model.
 */
export function titleFrom(text: string): string {
  const first = text.trim().split(/\r?\n/, 1)[0]!.replace(/\s+/g, " ").trim()
  return first.length > TITLE_LIMIT ? `${first.slice(0, TITLE_LIMIT - 1)}…` : first
}

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
  const checkAttachment = deps.checkAttachment ?? (async () => "outside" as const)

  const [state, setState] = createStore<ChatState>({ status: "idle", data: emptyChatData() })
  const setData = ((...args: unknown[]) => (setState as (...a: unknown[]) => void)("data", ...args)) as SetStoreFunction<ChatData>

  /** Bumped by every `open` and `close`: work of an older one stops touching the state. */
  let generation = 0
  let current: { connection: Open; stop: AbortController } | undefined
  /** Sessions whose messages are shown, reloaded after a reconnection. */
  const watched = new Set<string>()
  let catalogLoad: { mine: number; promise: Promise<ChatCatalog> } | undefined
  /** Sessions made here, with the chat's rules, before their event arrives. */
  const ours = new Set<string>()
  // A session made outside the chat — the TUI's, the web app's — is read, never written to (C5).
  const mustBeOurs = (id: string) => {
    if (!ours.has(id) && !hasChatRules(state.data.session.find((session) => session.id === id))) {
      throw new ForeignSession(t("chat.foreignSession"))
    }
  }
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

  async function catalog(): Promise<ChatCatalog> {
    const connection = opened()
    const mine = generation
    if (catalogLoad?.mine !== mine) {
      const promise = loadChatCatalog(connection.client).then((catalog) => {
        if (!catalog.providerList && catalogLoad?.promise === promise) catalogLoad = undefined
        return catalog
      })
      catalogLoad = { mine, promise }
    }
    return catalogLoad.promise
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
    if (!current) throw new Error(t("chat.error.notOpen"))
    return current.connection
  }

  return {
    state,
    async open(directory) {
      if (state.directory === directory && state.status !== "idle" && state.status !== "refused") return
      close()
      const mine = ++generation
      watched.clear()
      ours.clear()
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
    async send(sessionID, text, model, agent, files = []) {
      const connection = opened()
      const mine = generation
      const folder = state.directory ?? ""
      // A model the server does not have would end the turn without a word: said here instead.
      const known = catalogHasModel((await catalog()).providerList, model)
      if (known === false) throw new Error(t("chat.model.missing", serializeModelRef(model)))
      for (const file of files) {
        const path = pathOfFileUrl(file.url)
        if (!path || !insideProject(folder, path)) throw new Error(t("chat.attach.outside", path ?? file.url))
        if (isEnvFile(path)) throw new Error(t("chat.attach.env", path))
        // nikcli reads it without asking: Rust follows links and junctions before it goes.
        const check = await checkAttachment(folder, path)
        if (check === "notFile") throw new Error(t("chat.attach.notFile", path))
        if (check === "env") throw new Error(t("chat.attach.env", path))
        if (check !== "ok") throw new Error(t("chat.attach.outside", path))
      }
      let id = sessionID
      if (!id) {
        const created = await connection.client.session.create({ title: titleFrom(text), permission: [...CHAT_PERMISSION] })
        id = (created.data as unknown as Session).id
        if (mine === generation) ours.add(id)
      } else mustBeOurs(id)
      // Another folder opened meanwhile: the answer goes on in the first one, whose session it is.
      if (mine === generation) watched.add(id)
      await connection.client.session.promptAsync({
        sessionID: id,
        parts: [{ type: "text", text }, ...files],
        model,
        ...(agent ? { agent } : {}),
      })
      return id
    },
    async rename(sessionID, title) {
      const name = title.trim()
      if (!name) throw new Error(t("chat.session.emptyTitle"))
      mustBeOurs(sessionID)
      const mine = generation
      const result = await opened().client.session.update({ sessionID, title: name })
      // The server's event says the same; this shows it at once, stream down or not.
      const updated = result.data as unknown as Session | undefined
      if (mine === generation && updated?.id === sessionID) applyChatEvent({ type: "session.updated", properties: { info: updated } }, state.data, setData)
    },
    async abort(sessionID) {
      mustBeOurs(sessionID)
      await opened().client.session.abort({ sessionID })
    },
    async replyPermission(requestID, reply) {
      await opened().client.permission.reply({ requestID, reply })
    },
    async answerQuestion(requestID, answers) {
      await opened().client.question.reply({ requestID, answers: answers.map((labels) => [...labels]) })
    },
    async rejectQuestion(requestID) {
      await opened().client.question.reject({ requestID })
    },
    async loadMessages(sessionID) {
      watched.add(sessionID)
      if (current) await fetchMessages(current.connection, sessionID, generation)
    },
    async findFiles(query) {
      const found = await opened().client.find.files({ query, type: "file", limit: 20 })
      return Array.isArray(found.data) ? found.data.filter((path): path is string => typeof path === "string") : []
    },
    catalog,
  }
}

let app: ChatStore | undefined

/** The window's chat: made on first use, with the Rust bridge and the Bots' trust in the project. */
export function appChatStore(): ChatStore {
  app ??= createChatStore({
    connect: (directory) => openChat(directory, appChatConnectionDeps()),
    checkAttachment: tauriAttachmentCheck,
  })
  return app
}
