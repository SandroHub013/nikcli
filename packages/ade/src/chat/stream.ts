/**
 * The folder's event stream, read (C2).
 *
 * `GET /event` with the folder in `x-nikcli-directory`: the server's stream
 * for that instance only, `{type, properties}` per `data:` line, with
 * `server.connected` first and `server.heartbeat` every 30 s. Not
 * `/global/event`, which carries every folder's events (the proxy refuses
 * it). Read here rather than through the SDK's `event.subscribe`, so the
 * store decides what a silence, a close or an error means.
 *
 * The `fetch` is the chat's own (`ChatConnection.fetch`): bound to the folder
 * and to the project's trust, so the stream is checked like any request.
 */

import { SERVER_BASE } from "./transport"
import type { ChatEvent } from "./events"

/** The server said no to the stream itself (401 or 403): trying again will not help. */
export class StreamRefused extends Error {
  override readonly name = "StreamRefused"
}

/** The events of `directory`, as they come; ends when the server closes the stream. */
export async function* readEvents(
  fetch: typeof globalThis.fetch,
  directory: string,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const response = await fetch(new URL("/event", SERVER_BASE), {
    headers: { accept: "text/event-stream", "x-nikcli-directory": encodeURIComponent(directory) },
    signal,
  })
  if (response.status === 401 || response.status === 403) {
    throw new StreamRefused(`${response.status} ${response.statusText}`.trim())
  }
  if (!response.ok || !response.body) throw new TypeError(`/event: ${response.status}`)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += value.replace(/\r\n?/g, "\n")
      let end: number
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
        if (!data) continue
        let event: unknown
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }
        if (event && typeof (event as ChatEvent).type === "string") yield event as ChatEvent
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
