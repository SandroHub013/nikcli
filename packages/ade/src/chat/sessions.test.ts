import { describe, expect, test } from "bun:test"
import { emptyChatData, type ChatData } from "./events"
import { CHAT_PERMISSION } from "./rules"
import {
  connectionNotice,
  conversationOf,
  freeModelRef,
  messageError,
  followOpen,
  partsOf,
  sessionEntries,
} from "./sessions"

/* C4: the sessions the chat lists and the one it shows. */

const session = (id: string, updated: number, extra: Record<string, unknown> = {}) =>
  ({ id, title: `Sessione ${id}`, directory: "C:/progetto", time: { created: 1, updated }, ...extra }) as never

function data(patch: Partial<ChatData>): ChatData {
  return { ...emptyChatData(), ...patch }
}

describe("the session list", () => {
  test("newest first; archived and subagent sessions left out; the chat's own marked", () => {
    const list = sessionEntries(
      data({
        session: [
          session("ses_a", 10, { permission: [...CHAT_PERMISSION] }),
          session("ses_b", 30),
          session("ses_c", 20, { time: { created: 1, updated: 20, archived: 25 } }),
          session("ses_d", 40, { parentID: "ses_a" }),
          session("ses_e", 5, { title: "  " }),
        ],
      }),
    )
    expect(list.map((entry) => [entry.id, entry.chat])).toEqual([
      ["ses_b", false],
      ["ses_a", true],
      ["ses_e", false],
    ])
    // A blank title shows the id rather than nothing.
    expect(list.at(-1)!.title).toBe("ses_e")
  })

  test("says which session is answering and which waits for the user", () => {
    const list = sessionEntries(
      data({
        session: [session("ses_a", 3), session("ses_b", 2), session("ses_c", 1)],
        session_status: { ses_a: { type: "busy" }, ses_b: { type: "idle" } } as never,
        permission: { ses_b: [{ id: "per_1" }] } as never,
        question: { ses_c: [{ id: "que_1" }] } as never,
      }),
    )
    expect(list.map((entry) => [entry.id, entry.busy, entry.waiting])).toEqual([
      ["ses_a", true, false],
      ["ses_b", false, true],
      ["ses_c", false, true],
    ])
  })

  test("one just made stays open until the list has it; one that leaves the list closes", () => {
    const empty = sessionEntries(data({}))
    const listed = sessionEntries(data({ session: [session("ses_new", 1)] }))
    // Sent: the id is back before the server's event lists the session.
    let open = followOpen(empty, { id: "ses_new", seen: false })
    expect(open).toEqual({ id: "ses_new", seen: false })
    open = followOpen(listed, open)
    expect(open).toEqual({ id: "ses_new", seen: true })
    // Deleted elsewhere: gone from the list, so no longer open.
    expect(followOpen(empty, open)).toEqual({ seen: false })
    expect(followOpen(listed, { seen: false })).toEqual({ seen: false })
  })
})

describe("the open session", () => {
  test("its messages in order, each with its parts; every part for the permission cards", () => {
    const info = (id: string) => ({ id, sessionID: "ses_a", role: "assistant", time: { created: 1 } }) as never
    const part = (id: string, messageID: string) => ({ id, messageID, sessionID: "ses_a", type: "text", text: id }) as never
    const loaded = data({
      message: { ses_a: [info("msg_1"), info("msg_2")] },
      part: { msg_1: [part("prt_1", "msg_1")], msg_2: [part("prt_2", "msg_2"), part("prt_3", "msg_2")] },
    })
    expect(conversationOf(loaded, "ses_a").map((turn) => [turn.info.id, turn.parts.map((p) => p.id)])).toEqual([
      ["msg_1", ["prt_1"]],
      ["msg_2", ["prt_2", "prt_3"]],
    ])
    expect(partsOf(loaded, "ses_a").map((p) => p.id)).toEqual(["prt_1", "prt_2", "prt_3"])
    expect(conversationOf(loaded, "ses_none")).toEqual([])
  })

  test("an answer that failed says why, as the server said it", () => {
    const failed = { id: "msg_1", error: { name: "APIError", data: { message: "Rate limit exceeded: free-models-per-min." } } } as never
    expect(messageError(failed)).toBe("Rate limit exceeded: free-models-per-min.")
    expect(messageError({ id: "msg_2", error: { name: "MessageAbortedError", data: {} } } as never)).toBe("MessageAbortedError")
    expect(messageError({ id: "msg_3" } as never)).toBeUndefined()
  })
})

describe("before C3", () => {
  test("only a free OpenRouter model is sent; a paid one, or none, sends nothing", () => {
    expect(freeModelRef("nvidia/nemotron-3-super-120b-a12b:free")).toEqual({
      providerID: "openrouter",
      modelID: "nvidia/nemotron-3-super-120b-a12b:free",
    })
    expect(freeModelRef("anthropic/claude-sonnet-4.5")).toBeUndefined()
    expect(freeModelRef("")).toBeUndefined()
  })
})

describe("the connection, in words", () => {
  test("no project, on its way, refused with why; nothing when live", () => {
    expect(connectionNotice({ status: "idle" })).toEqual({ kind: "noProject" })
    expect(connectionNotice({ directory: "C:/progetto", status: "admitting" })).toEqual({ kind: "admitting" })
    expect(connectionNotice({ directory: "C:/progetto", status: "retrying" })).toEqual({ kind: "retrying" })
    expect(connectionNotice({ directory: "C:/progetto", status: "refused", problem: "No." })).toEqual({ kind: "refused", problem: "No." })
    expect(connectionNotice({ directory: "C:/progetto", status: "refused" })).toEqual({ kind: "refused" })
    expect(connectionNotice({ directory: "C:/progetto", status: "live" })).toBeUndefined()
  })
})
