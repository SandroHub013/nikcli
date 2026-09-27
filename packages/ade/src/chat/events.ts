/**
 * What the chat knows about a folder, and how each server event changes it (C2).
 *
 * Ported from the web app's `applyDirectoryEvent`
 * (`packages/app/src/context/global-sync/event-reducer.ts`), on the same kind
 * of Solid store, with the same ordering: every list is sorted by id and found
 * with `Binary.search`, and an update is `reconcile`d in place so a view bound
 * to a part does not redraw the whole message. The server sends every part
 * whole on each change, text included, so there are no deltas to stitch.
 *
 * Kept to what the chat shows: sessions and their status, messages and parts,
 * permissions, questions and todos. Left out: diffs, the VCS branch, LSP, the
 * instruction notices and the web app's session cap. An event this does not
 * know is ignored; `server.instance.disposed` asks the caller to load the
 * folder again (`"resync"`), since the instance it knew is gone.
 */

import { Binary } from "@nikcli-ai/util/binary"
import { produce, reconcile, type SetStoreFunction } from "solid-js/store"
import type {
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@nikcli-ai/sdk/httpapi"

export interface ChatData {
  /** Sorted by id. Child sessions (a subagent's) included: the view picks the roots. */
  session: Session[]
  session_status: Record<string, SessionStatus>
  /** By session id, sorted by id. */
  message: Record<string, Message[]>
  /** By message id, sorted by id. */
  part: Record<string, Part[]>
  /** By session id. */
  permission: Record<string, PermissionRequest[]>
  /** By session id. */
  question: Record<string, QuestionRequest[]>
  todo: Record<string, Todo[]>
}

export function emptyChatData(): ChatData {
  return { session: [], session_status: {}, message: {}, part: {}, permission: {}, question: {}, todo: {} }
}

export interface ChatEvent {
  readonly type: string
  readonly properties?: unknown
}

/** What the caller has to do after an event: `"resync"` means load the folder again. */
export type ChatEventOutcome = "resync" | undefined

/** Everything kept for a session that is gone. */
function forget(setStore: SetStoreFunction<ChatData>, sessionID: string) {
  if (!sessionID) return
  setStore(
    produce((draft) => {
      for (const message of draft.message[sessionID] ?? []) {
        if (message?.id) delete draft.part[message.id]
      }
      delete draft.message[sessionID]
      delete draft.todo[sessionID]
      delete draft.permission[sessionID]
      delete draft.question[sessionID]
      delete draft.session_status[sessionID]
    }),
  )
}

/** Adds `item` to a list sorted by id, or updates the one with its id; a missing list is created. */
function upsert<T extends { id: string }>(
  list: readonly T[] | undefined,
  item: T,
  write: {
    create: (items: T[]) => void
    replace: (index: number, value: T) => void
    insert: (index: number, value: T) => void
  },
) {
  if (!list) return write.create([item])
  const result = Binary.search(list as T[], item.id, (entry) => entry.id)
  if (result.found) return write.replace(result.index, item)
  write.insert(result.index, item)
}

export function applyChatEvent(
  event: ChatEvent,
  store: ChatData,
  setStore: SetStoreFunction<ChatData>,
): ChatEventOutcome {
  switch (event.type) {
    case "server.instance.disposed":
      return "resync"
    case "session.created":
    case "session.updated": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(store.session, info.id, (s) => s.id)
      if (info.time?.archived) {
        if (result.found)
          setStore(
            "session",
            produce((draft) => void draft.splice(result.index, 1)),
          )
        forget(setStore, info.id)
        return
      }
      if (result.found) setStore("session", result.index, reconcile(info))
      else
        setStore(
          "session",
          produce((draft) => void draft.splice(result.index, 0, info)),
        )
      return
    }
    case "session.deleted": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(store.session, info.id, (s) => s.id)
      if (result.found)
        setStore(
          "session",
          produce((draft) => void draft.splice(result.index, 1)),
        )
      forget(setStore, info.id)
      return
    }
    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      setStore("session_status", props.sessionID, reconcile(props.status))
      return
    }
    case "todo.updated": {
      const props = event.properties as { sessionID: string; todos: Todo[] }
      setStore("todo", props.sessionID, reconcile(props.todos, { key: "id" }))
      return
    }
    case "message.updated": {
      const info = (event.properties as { info: Message }).info
      upsert(store.message[info.sessionID], info, {
        create: (items) => setStore("message", info.sessionID, items),
        replace: (index, value) => setStore("message", info.sessionID, index, reconcile(value)),
        insert: (index, value) =>
          setStore(
            "message",
            info.sessionID,
            produce((draft) => void draft.splice(index, 0, value)),
          ),
      })
      return
    }
    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      setStore(
        produce((draft) => {
          const messages = draft.message[props.sessionID]
          if (messages) {
            const result = Binary.search(messages, props.messageID, (m) => m.id)
            if (result.found) messages.splice(result.index, 1)
          }
          delete draft.part[props.messageID]
        }),
      )
      return
    }
    case "message.part.updated": {
      const part = (event.properties as { part: Part }).part
      upsert(store.part[part.messageID], part, {
        create: (items) => setStore("part", part.messageID, items),
        replace: (index, value) => setStore("part", part.messageID, index, reconcile(value)),
        insert: (index, value) =>
          setStore(
            "part",
            part.messageID,
            produce((draft) => void draft.splice(index, 0, value)),
          ),
      })
      return
    }
    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      setStore(
        produce((draft) => {
          const list = draft.part[props.messageID]
          if (!list) return
          const result = Binary.search(list, props.partID, (p) => p.id)
          if (!result.found) return
          list.splice(result.index, 1)
          if (list.length === 0) delete draft.part[props.messageID]
        }),
      )
      return
    }
    case "permission.asked": {
      const permission = event.properties as PermissionRequest
      upsert(store.permission[permission.sessionID], permission, {
        create: (items) => setStore("permission", permission.sessionID, items),
        replace: (index, value) => setStore("permission", permission.sessionID, index, reconcile(value)),
        insert: (index, value) =>
          setStore(
            "permission",
            permission.sessionID,
            produce((draft) => void draft.splice(index, 0, value)),
          ),
      })
      return
    }
    case "permission.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      removeRequest(store.permission[props.sessionID], props.requestID, (index) =>
        setStore(
          "permission",
          props.sessionID,
          produce((draft) => void draft.splice(index, 1)),
        ),
      )
      return
    }
    case "question.asked": {
      const question = event.properties as QuestionRequest
      upsert(store.question[question.sessionID], question, {
        create: (items) => setStore("question", question.sessionID, items),
        replace: (index, value) => setStore("question", question.sessionID, index, reconcile(value)),
        insert: (index, value) =>
          setStore(
            "question",
            question.sessionID,
            produce((draft) => void draft.splice(index, 0, value)),
          ),
      })
      return
    }
    case "question.replied":
    case "question.rejected": {
      const props = event.properties as { sessionID: string; requestID: string }
      removeRequest(store.question[props.sessionID], props.requestID, (index) =>
        setStore(
          "question",
          props.sessionID,
          produce((draft) => void draft.splice(index, 1)),
        ),
      )
      return
    }
  }
  return
}

function removeRequest(list: readonly { id: string }[] | undefined, id: string, remove: (index: number) => void) {
  if (!list) return
  const result = Binary.search(list as { id: string }[], id, (entry) => entry.id)
  if (result.found) remove(result.index)
}
