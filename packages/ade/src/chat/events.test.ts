import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { applyChatEvent, emptyChatData, type ChatEvent } from "./events"

/*
 * C2: the chat's events, ported from the web app's reducer. Written by hand
 * like the web app's own tests; a recorded conversation is replayed
 * separately, with the fixtures.
 */

function chat() {
  const [store, setStore] = createStore(emptyChatData())
  const apply = (...events: ChatEvent[]) => events.map((event) => applyChatEvent(event, store, setStore))
  return { store, apply }
}

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "session.updated",
  properties: { info: { id, title: id, time: { created: 1, updated: 1 }, ...extra } },
})
const message = (id: string, sessionID = "ses_1", role = "assistant") => ({
  type: "message.updated",
  properties: { info: { id, sessionID, role, time: { created: 1 } } },
})
const text = (id: string, messageID: string, value: string) => ({
  type: "message.part.updated",
  properties: { part: { id, messageID, sessionID: "ses_1", type: "text", text: value } },
})

describe("the chat's events", () => {
  test("sessions stay sorted by id; an archived one leaves with everything it had", () => {
    const { store, apply } = chat()
    apply(session("ses_3"), session("ses_1"), { type: "session.created", properties: session("ses_2").properties })
    expect(store.session.map((s) => s.id)).toEqual(["ses_1", "ses_2", "ses_3"])
    apply(session("ses_2", { title: "rinominata" }))
    expect(store.session[1]!.title).toBe("rinominata")
    expect(store.session).toHaveLength(3)

    apply(message("msg_1", "ses_2"), text("prt_1", "msg_1", "ciao"), {
      type: "session.status",
      properties: { sessionID: "ses_2", status: { type: "busy" } },
    })
    apply(session("ses_2", { time: { created: 1, updated: 2, archived: 3 } }))
    expect(store.session.map((s) => s.id)).toEqual(["ses_1", "ses_3"])
    expect(store.message.ses_2).toBeUndefined()
    expect(store.part.msg_1).toBeUndefined()
    expect(store.session_status.ses_2).toBeUndefined()
  })

  test("a deleted session goes, with its messages and parts", () => {
    const { store, apply } = chat()
    apply(session("ses_1"), message("msg_1"), text("prt_1", "msg_1", "x"))
    apply({ type: "session.deleted", properties: session("ses_1").properties })
    expect(store.session).toEqual([])
    expect(store.message.ses_1).toBeUndefined()
    expect(store.part.msg_1).toBeUndefined()
  })

  test("a streamed answer: the same part again with more text replaces it in place", () => {
    const { store, apply } = chat()
    apply(message("msg_2"), message("msg_1", "ses_1", "user"))
    expect(store.message.ses_1!.map((m) => m.id)).toEqual(["msg_1", "msg_2"])
    apply(text("prt_2", "msg_2", "Ciao"))
    const first = store.part.msg_2![0]
    apply(text("prt_2", "msg_2", "Ciao, come"), text("prt_2", "msg_2", "Ciao, come stai?"))
    expect(store.part.msg_2).toHaveLength(1)
    expect((store.part.msg_2![0] as { text: string }).text).toBe("Ciao, come stai?")
    // Reconciled, not replaced: a view bound to the part keeps its object.
    expect(store.part.msg_2![0]).toBe(first)
    apply(text("prt_1", "msg_2", "prima"))
    expect(store.part.msg_2!.map((p) => p.id)).toEqual(["prt_1", "prt_2"])
  })

  test("removing a message takes its parts; removing the last part drops the list", () => {
    const { store, apply } = chat()
    apply(message("msg_1"), text("prt_1", "msg_1", "a"), message("msg_2"), text("prt_2", "msg_2", "b"))
    apply({ type: "message.removed", properties: { sessionID: "ses_1", messageID: "msg_1" } })
    expect(store.message.ses_1!.map((m) => m.id)).toEqual(["msg_2"])
    expect(store.part.msg_1).toBeUndefined()
    apply({ type: "message.part.removed", properties: { messageID: "msg_2", partID: "prt_2" } })
    expect(store.part.msg_2).toBeUndefined()
    // Removing what is not there changes nothing.
    apply({ type: "message.part.removed", properties: { messageID: "msg_9", partID: "prt_9" } })
    apply({ type: "message.removed", properties: { sessionID: "ses_9", messageID: "msg_9" } })
    expect(store.message.ses_1).toHaveLength(1)
  })

  test("a permission and a question wait until they are answered, rejected included", () => {
    const { store, apply } = chat()
    apply(
      { type: "permission.asked", properties: { id: "per_2", sessionID: "ses_1", permission: "bash", patterns: ["ls"] } },
      { type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1", permission: "edit", patterns: ["a.ts"] } },
      { type: "question.asked", properties: { id: "que_1", sessionID: "ses_1", questions: [] } },
      { type: "question.asked", properties: { id: "que_2", sessionID: "ses_1", questions: [] } },
    )
    expect(store.permission.ses_1!.map((p) => p.id)).toEqual(["per_1", "per_2"])
    apply({ type: "permission.replied", properties: { sessionID: "ses_1", requestID: "per_1", reply: "once" } })
    expect(store.permission.ses_1!.map((p) => p.id)).toEqual(["per_2"])
    apply(
      { type: "question.replied", properties: { sessionID: "ses_1", requestID: "que_1" } },
      { type: "question.rejected", properties: { sessionID: "ses_1", requestID: "que_2" } },
    )
    expect(store.question.ses_1).toEqual([])
  })

  test("status and todos are the latest sent", () => {
    const { store, apply } = chat()
    apply(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { type: "todo.updated", properties: { sessionID: "ses_1", todos: [{ id: "t1", content: "uno", status: "pending" }] } },
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
    )
    expect(store.session_status.ses_1).toEqual({ type: "idle" })
    expect(store.todo.ses_1!.map((todo) => todo.id)).toEqual(["t1"])
  })

  test("a disposed instance asks for the folder again; anything else unknown is ignored", () => {
    const { store, apply } = chat()
    expect(apply({ type: "server.instance.disposed", properties: { directory: "C:/progetto" } })).toEqual(["resync"])
    const before = JSON.stringify(store)
    expect(
      apply(
        { type: "server.connected", properties: {} },
        { type: "server.heartbeat", properties: {} },
        { type: "lsp.updated", properties: {} },
        { type: "vcs.branch.updated", properties: { branch: "main" } },
        { type: "qualcosa.di.nuovo", properties: { x: 1 } },
      ),
    ).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(JSON.stringify(store)).toBe(before)
  })
})
