/**
 * How the chat reaches the nikcli server: through ADE's Rust side, never with
 * the WebView's own `fetch` (C1).
 *
 * A release page's origin is `tauri.localhost`, which the server's CORS does
 * not accept, so a `fetch` from here worked under Vite and failed in the app
 * the user runs. ADE's own server also has a random password, and the page
 * must not hold it. So `serve.rs` finds or starts the server and keeps its
 * address and credentials; `serve_proxy.rs` makes each call and streams the
 * answer back on a channel. What this file gives the SDK is a `fetch` built
 * on that — status and headers first, then the body as it arrives — so the
 * server's event stream works the same as any other call.
 *
 * The SDK is given `SERVER_BASE` as its base URL: a name, not an address. The
 * real one stays in Rust, and a request for any other origin is refused here
 * before it goes anywhere.
 */

import { t } from "../i18n"

/** The base URL the SDK is given. Not an address anything listens on. */
export const SERVER_BASE = "http://nikcli.ade"

/** What `nikcli_serve_start` says about the server. Never a password. */
export interface ServerInfo {
  readonly url: string
  readonly version: string | null
}

export interface ProxyRequest {
  readonly method: string
  /** Path and query, starting with `/`. */
  readonly path: string
  readonly headers: readonly (readonly [string, string])[]
  readonly body?: string
}

/** What `nikcli_serve_fetch` streams back: one head, chunks, then end — or an error. */
export type ProxyEvent =
  | { readonly kind: "head"; readonly status: number; readonly headers: readonly (readonly [string, string])[] }
  | { readonly kind: "chunk"; readonly bytes: readonly number[] }
  | { readonly kind: "end" }
  | { readonly kind: "error"; readonly message: string }

/** The three Rust commands, as the page sees them. Tests pass a fake. */
export interface ServerBridge {
  start(directory?: string): Promise<ServerInfo>
  /** Sends the request; resolves with its id once it is on its way. */
  send(request: ProxyRequest, onEvent: (event: ProxyEvent) => void): Promise<number>
  abort(id: number): Promise<void>
}

/** The bridge over Tauri: `invoke` and a `Channel` for the answer. */
export function tauriServerBridge(): ServerBridge {
  return {
    async start(directory) {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<ServerInfo>("nikcli_serve_start", { directory: directory ?? null })
    },
    async send(request, onEvent) {
      const { invoke, Channel } = await import("@tauri-apps/api/core")
      const channel = new Channel<ProxyEvent>()
      channel.onmessage = onEvent
      return invoke<number>("nikcli_serve_fetch", { request, onEvent: channel })
    },
    async abort(id) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("nikcli_serve_abort", { id })
    },
  }
}

/** Statuses a `Response` must be built without a body for. */
const NO_BODY = new Set([101, 204, 205, 304])

function abortError(): Error {
  return new DOMException(t("chat.error.requestAborted"), "AbortError")
}

/**
 * A `fetch` for the SDK that goes through `bridge`.
 *
 * The server is found or started on the first call, once; a start that fails
 * is tried again on the next call rather than remembered, because the usual
 * cause — nikcli not installed yet, a server still loading — does not last.
 */
export function serverFetch(bridge: ServerBridge, options: { directory?: string } = {}): typeof globalThis.fetch {
  const base = new URL(SERVER_BASE)
  let started: Promise<ServerInfo> | undefined
  const ensure = () => {
    started ??= bridge.start(options.directory).catch((error: unknown) => {
      started = undefined
      throw error
    })
    return started
  }

  const call = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== base.origin) {
      throw new TypeError(t("chat.error.otherOrigin", url.origin))
    }
    const signal = init?.signal ?? request.signal
    if (signal?.aborted) throw abortError()

    await ensure()
    const method = request.method.toUpperCase()
    const body = method === "GET" || method === "HEAD" ? undefined : await request.text()
    const headers: [string, string][] = []
    request.headers.forEach((value, name) => {
      if (name !== "authorization") headers.push([name, value])
    })

    return new Promise<Response>((resolve, reject) => {
      let id: number | undefined
      let aborted = false
      let settled = false
      let finished = false
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c
        },
        cancel() {
          // The reader stopped: the server's stream is not needed any more.
          finished = true
          stop()
        },
      })

      const stop = () => {
        if (id !== undefined) void bridge.abort(id).catch(() => {})
        else aborted = true
      }

      const onAbort = () => {
        if (finished) return
        finished = true
        stop()
        if (!settled) {
          settled = true
          reject(abortError())
        } else controller?.error(abortError())
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      const done = () => {
        finished = true
        signal?.removeEventListener("abort", onAbort)
      }

      const onEvent = (event: ProxyEvent) => {
        if (finished) return
        switch (event.kind) {
          case "head": {
            settled = true
            const responseHeaders = new Headers(event.headers.map(([name, value]) => [name, value] as [string, string]))
            resolve(new Response(NO_BODY.has(event.status) ? null : stream, { status: event.status, headers: responseHeaders }))
            if (NO_BODY.has(event.status)) done()
            return
          }
          case "chunk":
            controller?.enqueue(new Uint8Array(event.bytes))
            return
          case "end":
            done()
            controller?.close()
            return
          case "error":
            done()
            if (!settled) {
              settled = true
              // Worth finding the server again: ADE starts a new one if it stopped.
              started = undefined
              reject(new TypeError(event.message))
            } else controller?.error(new TypeError(event.message))
            return
        }
      }

      bridge
        .send({ method, path: url.pathname + url.search, headers, body }, onEvent)
        .then((sent) => {
          id = sent
          if (aborted) void bridge.abort(sent).catch(() => {})
        })
        .catch((error: unknown) => {
          if (finished) return
          done()
          settled = true
          reject(error instanceof Error ? error : new TypeError(String(error)))
        })
    })
  }

  // `preconnect` has no behaviour to keep; it only has to exist for the type.
  return Object.assign(call, { preconnect: () => undefined }) as typeof globalThis.fetch
}
