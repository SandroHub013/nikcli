import { describe, expect, test } from "bun:test"
import { openChat } from "./connection"
import { readEvents, StreamRefused } from "./stream"
import type { ProxyEvent, ProxyRequest, ServerBridge } from "./transport"

/* C2: the folder's `/event` stream, through the chat's own bridge. */

const PROJECT = "C:/progetto"
const bytes = (text: string) => Array.from(new TextEncoder().encode(text))

/** A bridge whose `/event` answers `status` and then the given chunks, and stays open. */
function streamingBridge(status: number, chunks: string[]) {
  const sent: ProxyRequest[] = []
  const aborted: number[] = []
  const bridge: ServerBridge = {
    async start() {
      return { url: "http://127.0.0.1:49374", version: "1.389.0", shared: true }
    },
    async send(request, onEvent: (event: ProxyEvent) => void) {
      sent.push(request)
      setTimeout(async () => {
        onEvent({ kind: "head", status, headers: [["content-type", "text/event-stream"]] })
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, 1))
          onEvent({ kind: "chunk", bytes: bytes(chunk) })
        }
      }, 0)
      return sent.length
    },
    async abort(id) {
      aborted.push(id)
    },
  }
  return { bridge, sent, aborted }
}

async function connection(bridge: ServerBridge) {
  const opened = await openChat(PROJECT, { bridge, admit: async () => ({ ok: true }) })
  if (!opened.ok) throw new Error("non aperta")
  return opened
}

describe("the folder's event stream", () => {
  test("frames split anywhere, CRLF, comments and noise: only whole events come out, for this folder", async () => {
    const fake = streamingBridge(200, [
      'data: {"type":"server.connected","properties":{}}\r\n\r\n: un commento\n\ndata: {"type":"session.st',
      'atus","properties":{"sessionID":"ses_1","status":{"type":"busy"}}}\n',
      "\ndata: non è json\n\n",
      'data: {"type":"server.heartbeat",\ndata: "properties":{}}\n\n',
    ])
    const opened = await connection(fake.bridge)
    const controller = new AbortController()
    const seen: string[] = []
    for await (const event of readEvents(opened.fetch, PROJECT, controller.signal)) {
      seen.push(event.type)
      if (seen.length === 3) break
    }
    expect(seen).toEqual(["server.connected", "session.status", "server.heartbeat"])
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]!.path).toBe("/event")
    const headers = new Map(fake.sent[0]!.headers.map(([name, value]) => [name.toLowerCase(), value]))
    expect(decodeURIComponent(headers.get("x-nikcli-directory")!)).toBe(PROJECT)
    // Leaving the loop closed the server's stream, once.
    expect(fake.aborted).toEqual([1])
  })

  test("a 403 is a refusal, not something to try again", async () => {
    const fake = streamingBridge(403, [])
    const opened = await connection(fake.bridge)
    const reading = readEvents(opened.fetch, PROJECT, new AbortController().signal).next()
    await expect(reading).rejects.toBeInstanceOf(StreamRefused)
  })

  test("aborted while it waits, the stream stops, and the server's side is closed once", async () => {
    const fake = streamingBridge(200, ['data: {"type":"server.connected","properties":{}}\n\n'])
    const opened = await connection(fake.bridge)
    const controller = new AbortController()
    const seen: string[] = []
    const reading = (async () => {
      for await (const event of readEvents(opened.fetch, PROJECT, controller.signal)) {
        seen.push(event.type)
        controller.abort()
      }
    })()
    await expect(reading).rejects.toThrow()
    expect(seen).toEqual(["server.connected"])
    expect(fake.aborted).toEqual([1])
    expect(fake.sent).toHaveLength(1)
  })
})
