/**
 * The mods of one admitted folder, as a `ModSource` ADE's window can draw from.
 *
 * Plain TypeScript, apart from the component that uses it (`mods.tsx`), so the stream's behaviour can
 * be tested without a DOM.
 */
import type { ModHostEvent, ModSource } from "@nikcli-ai/ui/mod-tree-model"
import { isChatRefused, type ChatConnection } from "../../chat/connection"
import { readEvents, StreamRefused } from "../../chat/stream"

/** How long the event stream waits before it is read again after it drops. */
export const RECONNECT_MS = 2_000

export type OpenConnection = Extract<ChatConnection, { ok: true }>

export interface AdeModSource extends ModSource {
  /** Stops the event stream. The source is not used again. */
  close(): void
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * The mods of one admitted folder: calls through the chat's own client, and the folder's event stream
 * fanned out to whoever draws. Every time the stream (re)connects the server says `server.connected`,
 * which is passed on as an untargeted invalidation: whatever happened while it was down, redraw.
 */
export function adeModSource(connection: OpenConnection, reconnectMs = RECONNECT_MS): AdeModSource {
  const listeners = new Set<(event: ModHostEvent) => void>()
  const abort = new AbortController()
  const emit = (event: ModHostEvent) => {
    for (const listener of listeners) listener(event)
  }

  void (async () => {
    while (!abort.signal.aborted) {
      try {
        for await (const event of readEvents(connection.fetch, connection.directory, abort.signal)) {
          if (event.type === "server.connected") emit({ type: "mod.ui.invalidate", properties: {} })
          else if (event.type.startsWith("mod.ui.")) {
            emit({ type: event.type, properties: event.properties as Record<string, unknown> | undefined })
          }
        }
      } catch (error) {
        // A no, from the server or from the folder's trust, does not change by asking again.
        if (error instanceof StreamRefused || isChatRefused(error)) return
      }
      await sleep(reconnectMs, abort.signal)
    }
  })()

  const client = connection.client
  return {
    surface: "ade",
    list: async () =>
      (await client.mod.list()).data?.map((mod) => ({
        ...mod,
        events: [...mod.events],
        tools: [...mod.tools],
        commands: [...mod.commands],
      })),
    panes: async () => (await client.mod.panes()).data?.map((pane) => ({ ...pane })),
    render: async (input) =>
      (
        await client.mod.render({
          component: input.component,
          requestId: input.requestId,
          sessionID: input.sessionID,
          props: JSON.stringify(input.props ?? {}),
          surface: "ade",
        })
      ).data,
    event: async (input) => (await client.mod.event(input)).data,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => abort.abort(),
  }
}
