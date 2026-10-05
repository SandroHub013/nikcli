/**
 * The streaming socket to xAI, through ADE's Rust host.
 *
 * The WebView never talks to the service itself: the key lives on the other
 * side of the Tauri boundary (`stt_stream_open` reads it and answers
 * `no-key` without touching the network), the socket is a WebSocket the page
 * could not open, and each frame goes as a raw body with the session's id in
 * the `x-stt-id` header — `src-tauri/src/stt_stream.rs` is the other half.
 * This file is the `SttStreamTransport` the voice package defines, built over
 * `invoke` and a `Channel`, with a bridge in between so tests never need
 * Tauri.
 *
 * One session at a time, and the voice package's chain is what guarantees
 * it: `send` and `cancel` name no session, so two sockets alive at once
 * could not be told apart. This transport says so out loud rather than
 * routing a frame to the wrong socket if that ever stops being true.
 */

import type { SttStreamEvent, SttStreamOpenOptions, SttStreamTransport } from "@nikcli-ai/voice"
import { STT_STREAM_CANCELLED } from "@nikcli-ai/voice/core"

/** The four Rust commands, as the page sees them. Tests pass a fake. */
export interface SttStreamBridge {
  /** Opens the session; resolves with its id once Rust has it. */
  open(
    language: string | undefined,
    keyterms: readonly string[],
    onEvent: (event: SttStreamEvent) => void,
  ): Promise<number>
  /** One frame of PCM16LE audio, tagged with the session it belongs to. */
  send(id: number, bytes: Uint8Array): Promise<void>
  /** The segment is over: the audio ends, and `done` follows. */
  end(id: number): Promise<void>
  /** The segment is dropped: the socket closes and no event follows. */
  cancel(id: number): Promise<void>
}

/** The bridge over Tauri: `invoke`, a `Channel` for the events, a header for the id. */
export function tauriSttStreamBridge(): SttStreamBridge {
  return {
    async open(language, keyterms, onEvent) {
      const { invoke, Channel } = await import("@tauri-apps/api/core")
      const channel = new Channel<SttStreamEvent>()
      channel.onmessage = onEvent
      return invoke<number>("stt_stream_open", {
        language: language ?? null,
        keyterms: [...keyterms],
        onEvent: channel,
      })
    },
    async send(id, bytes) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("stt_stream_send", bytes, { headers: { "x-stt-id": String(id) } })
    },
    async end(id) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("stt_stream_end", { id })
    },
    async cancel(id) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("stt_stream_cancel", { id })
    },
  }
}

/** One live session: known by its id once the open has landed. */
interface LiveSession {
  id?: number
  /** Cancelled before or during its life: Rust must not keep it. */
  dropped: boolean
  /** Closed here: done, failed, or cancelled — no event of it is welcome. */
  closed: boolean
}

/**
 * The transport the voice package asks for, over one session at a time.
 *
 * A session closes on `done` or `failed`, on `cancel`, or when the open
 * itself is refused — and a session cancelled while it was still opening
 * cancels for real the moment its id arrives, because Rust already made it.
 */
export function createSttStreamTransport(bridge: SttStreamBridge = tauriSttStreamBridge()): SttStreamTransport {
  let session: LiveSession | undefined
  /** The last session went by `cancel`: a send or an end still on its way says so, not «no session». */
  let cancelled = false
  const missing = (what: string) =>
    new Error(cancelled ? `${STT_STREAM_CANCELLED}: la sessione è stata annullata.` : what)

  const close = (current: LiveSession): void => {
    current.closed = true
    if (session === current) session = undefined
  }

  return {
    async open(options: SttStreamOpenOptions): Promise<void> {
      if (session) {
        throw new Error("Una sessione stt_stream è già aperta: una alla volta.")
      }
      const current: LiveSession = { dropped: false, closed: false }
      session = current
      cancelled = false
      try {
        const id = await bridge.open(options.language, options.keyterms, (event) => {
          if (current.closed) return
          options.onEvent(event)
          if (event.kind === "done" || event.kind === "failed") close(current)
        })
        current.id = id
        if (current.dropped) {
          void bridge.cancel(id).catch(() => {})
          close(current)
        }
      } catch (error) {
        close(current)
        throw error
      }
    },

    async send(bytes: Uint8Array): Promise<void> {
      const current = session
      if (!current?.id) throw missing("Nessuna sessione stt_stream da cui inviare l'audio.")
      await bridge.send(current.id, bytes)
    },

    async end(): Promise<void> {
      const current = session
      if (!current?.id) throw missing("Nessuna sessione stt_stream da chiudere.")
      await bridge.end(current.id)
      // The session stays until `done` or `failed` closes it.
    },

    cancel(): void {
      const current = session
      if (!current) return
      current.dropped = true
      cancelled = true
      if (current.id === undefined) return
      const id = current.id
      close(current)
      void bridge.cancel(id).catch(() => {})
    },
  }
}
