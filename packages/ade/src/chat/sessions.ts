/**
 * The chat's sessions and the one open, as the view shows them (C4).
 *
 * The list is the folder's sessions on the nikcli server, from the store
 * (`store.ts`): what the TUI or the web app made is there too, marked as not
 * the chat's, because only a session made with the chat's permission rules
 * (`rules.ts`) is written to. The view is a `.tsx`, which `bun test` cannot
 * import, so everything it decides is here.
 */

import type { Message, Part, Session } from "@nikcli-ai/sdk/httpapi"
import type { ChatData } from "./events"
import { hasChatRules } from "./rules"
import type { ChatState, ModelRef } from "./store"

export interface SessionEntry {
  readonly id: string
  readonly title: string
  /** When it last changed, for the order: the newest first. */
  readonly updated: number
  /** An answer is running in it. */
  readonly busy: boolean
  /** A permission request or a question waits for the user in it. */
  readonly waiting: boolean
  /** Made by the chat, with its rules: the only ones it writes to. */
  readonly chat: boolean
}

type Raw = Record<string, any>

const updatedOf = (session: Session) => Number((session as unknown as Raw).time?.updated ?? (session as unknown as Raw).time?.created ?? 0)

export function isBusy(data: ChatData, sessionID: string): boolean {
  const type = (data.session_status[sessionID] as Raw | undefined)?.type
  return type === "busy" || type === "retry"
}

/** The folder's sessions the chat lists: not archived, not a subagent's, the newest first. */
export function sessionEntries(data: ChatData): SessionEntry[] {
  return data.session
    .filter((session) => {
      const raw = session as unknown as Raw
      return !raw.time?.archived && !raw.parentID
    })
    .map((session) => ({
      id: session.id,
      title: String((session as unknown as Raw).title ?? "").trim() || session.id,
      updated: updatedOf(session),
      busy: isBusy(data, session.id),
      waiting: (data.permission[session.id]?.length ?? 0) + (data.question[session.id]?.length ?? 0) > 0,
      chat: hasChatRules(session),
    }))
    .sort((a, b) => b.updated - a.updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

export interface Turn {
  readonly info: Message
  readonly parts: readonly Part[]
}

/** A session's messages, in order, each with its parts. */
export function conversationOf(data: ChatData, sessionID: string): Turn[] {
  return (data.message[sessionID] ?? []).map((info) => ({ info, parts: data.part[info.id] ?? [] }))
}

/** The parts of every message of a session, for finding the call a permission request is about. */
export function partsOf(data: ChatData, sessionID: string): Part[] {
  return (data.message[sessionID] ?? []).flatMap((info) => data.part[info.id] ?? [])
}

/** What went wrong in an answer, as the server says it; nothing when it did not. */
export function messageError(info: Message): string | undefined {
  const error = (info as unknown as Raw).error
  if (!error) return undefined
  const message = error.data?.message
  return typeof message === "string" && message.trim() ? message : String(error.name ?? "Error")
}

/** The session open, and whether the list has shown it yet. */
export interface OpenSession {
  readonly id?: string
  readonly seen: boolean
}

/**
 * The session open after the list changed. One just made is open before its
 * event puts it in the list; it closes only once it was there and is gone
 * (deleted, archived, or another folder's list).
 */
export function followOpen(entries: readonly SessionEntry[], open: OpenSession): OpenSession {
  if (!open.id) return { seen: false }
  if (entries.some((entry) => entry.id === open.id)) return { id: open.id, seen: true }
  return open.seen ? { seen: false } : open
}

/**
 * The picker's choice as the server names it, until C3 brings the provider's
 * list: only an OpenRouter model marked `:free` becomes one. Anything else
 * gives nothing, and the chat does not send: the server's default and the
 * picker's own entries can be paid models.
 */
export function freeModelRef(id: string): ModelRef | undefined {
  const modelID = id.trim()
  return modelID.endsWith(":free") ? { providerID: "openrouter", modelID } : undefined
}

export type ChatNotice =
  | { readonly kind: "noProject" }
  | { readonly kind: "admitting" | "connecting" | "retrying" }
  | { readonly kind: "refused"; readonly problem?: string }

/** What the chat says about its connection, when it is not simply live. */
export function connectionNotice(state: Pick<ChatState, "directory" | "status" | "problem">): ChatNotice | undefined {
  if (!state.directory) return { kind: "noProject" }
  switch (state.status) {
    case "admitting":
    case "connecting":
    case "retrying":
      return { kind: state.status }
    case "refused":
      return state.problem ? { kind: "refused", problem: state.problem } : { kind: "refused" }
    default:
      return undefined
  }
}
