import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createStore } from "solid-js/store"
import { applyChatEvent, emptyChatData, type ChatEvent } from "./events"
import { hasChatRules } from "./rules"

/*
 * C2: real conversations, replayed. Recorded from `nikcli serve` 1.389 on this
 * folder's `/event` stream, on a free model only (OpenRouter
 * `nvidia/nemotron-3-super-120b-a12b:free`, then `qwen/qwen3.8-27b:free`,
 * which answered 429): every assistant message says cost 0. The machine's
 * paths are replaced, and so is the account id in the provider's refusals;
 * telemetry records, the provider's response headers, and the streamed pieces
 * the chat does not read (a part update's `delta`, the provider's
 * `reasoning_details`: every update carries the whole part) are dropped;
 * everything else is as the server sent it, heartbeats and the events the chat
 * does not read included.
 *
 * `*.final.json` is `GET /session/:id/message` taken at the end of each: what
 * the reducer builds from the stream alone has to be that. The messages
 * exactly; the parts in what the chat shows (id, kind, text, tool and its
 * state), because the server keeps a reasoning part as one of its middle
 * updates: without `time.end`, with only the last piece of reasoning in its
 * metadata and with the text before its final trim, while the stream's last
 * event for it has all three. The stream is
 * the more complete one, and it is what the chat reads.
 *
 * - `conversazione`: a file read with a tool, an answer, a shell command, an
 *   answer, and a long answer stopped by the user.
 * - `errori`: three turns the provider refused (429, with the server's
 *   retries), the last one stopped.
 * - `permesso` (C5): the same three turns on a session made with the chat's
 *   rules (`rules.ts`), on this machine's `build` agent, whose config allows
 *   every shell command: the read goes unasked, the `mkdir` asks, the chat
 *   says no, and the tool fails with the server's refusal.
 */

type Final = { info: { id: string; role: string; cost?: number; providerID?: string; modelID?: string }; parts: { id: string }[] }[]

const fixture = (name: string) => ({
  events: readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChatEvent),
  final: JSON.parse(readFileSync(new URL(`./fixtures/${name}.final.json`, import.meta.url), "utf8")) as Final,
})

function replay(events: ChatEvent[]) {
  const [store, setStore] = createStore(emptyChatData())
  const outcomes = events.map((event) => applyChatEvent(event, store, setStore))
  return { store, outcomes }
}

/** A plain copy of the store's contents, to compare with JSON. */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

/** What the chat shows of a part. */
const shown = (part: Record<string, any>) => ({
  id: part.id,
  type: part.type,
  text: part.type === "reasoning" ? part.text?.trimEnd() : part.text,
  tool: part.tool,
  status: part.state?.status,
  output: part.state?.output,
})

describe("a recorded conversation, replayed", () => {
  for (const name of ["conversazione", "errori", "permesso"]) {
    test(`${name}: the messages and their parts are exactly what the server has at the end`, () => {
      const { events, final } = fixture(name)
      const { store, outcomes } = replay(events)
      const sessionID = store.session[0]!.id
      expect(store.session).toHaveLength(1)
      expect(plain(store.message[sessionID]!)).toEqual(final.map((m) => m.info) as never)
      for (const message of final) {
        expect((store.part[message.info.id] ?? []).map(shown)).toEqual(message.parts.map(shown))
      }
      // No part left over from a message that is not there.
      expect(Object.keys(store.part).sort()).toEqual(final.filter((m) => m.parts.length > 0).map((m) => m.info.id).sort())
      expect(store.session_status[sessionID]).toEqual({ type: "idle" })
      expect(store.permission[sessionID] ?? []).toEqual([])
      expect(store.question[sessionID] ?? []).toEqual([])
      expect(outcomes.filter((outcome) => outcome !== undefined)).toEqual([])
    })
  }

  test("recorded on a free model only", () => {
    for (const name of ["conversazione", "errori", "permesso"]) {
      for (const message of fixture(name).final.filter((m) => m.info.role === "assistant")) {
        expect(message.info.modelID).toMatch(/:free$/)
        expect(message.info.cost ?? 0).toBe(0)
      }
    }
  })

  test("conversazione: a tool call, the answer after it, and the stop", () => {
    const { events } = fixture("conversazione")
    const { store } = replay(events)
    const parts = Object.values(store.part).flat()
    expect(parts.some((part) => part.type === "tool" && (part as { tool: string }).tool === "read")).toBe(true)
    expect(
      parts.some((part) => part.type === "text" && (part as { text: string }).text.includes("girasole")),
    ).toBe(true)
    const last = store.message[store.session[0]!.id]!.at(-1) as { role: string; error?: { name: string } }
    expect(last.role).toBe("assistant")
    expect(last.error?.name).toBe("MessageAbortedError")
  })

  test("permesso: the chat's rules beat the agent's shell allow; the no reached the server", () => {
    const { events } = fixture("permesso")
    const [store, setStore] = createStore(emptyChatData())
    const waiting: string[] = []
    for (const event of events) {
      applyChatEvent(event, store, setStore)
      for (const permission of Object.values(store.permission).flat()) {
        if (!waiting.includes(permission.permission)) waiting.push(permission.permission)
      }
    }
    expect(hasChatRules(store.session[0])).toBe(true)
    // Only the shell asked: the read did not.
    expect(waiting).toEqual(["bash"])
    const asked = events.find((event) => event.type === "permission.asked")!.properties as { patterns: string[] }
    expect(asked.patterns).toEqual(["mkdir prova-permesso"])
    expect(events.find((event) => event.type === "permission.replied")!.properties).toMatchObject({ reply: "reject" })
    const bash = Object.values(store.part)
      .flat()
      .find((part) => part.type === "tool" && (part as { tool: string }).tool === "bash") as { state: { status: string; error: string } }
    expect(bash.state.status).toBe("error")
    expect(bash.state.error).toContain("PermissionRejectedError")
  })
})
