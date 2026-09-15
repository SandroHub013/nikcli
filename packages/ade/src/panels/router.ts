import {
  describeCapabilities,
  formatReply,
  parseRequest,
  type PanelOutcome,
  type PanelRequest,
  type PanelVerb,
} from "./protocol"

/**
 * Where a request from an agent ends up.
 *
 * `protocol.ts` decides what a request *is*; this decides who answers it.
 * Kept apart because the two fail differently: a grammar bug makes ADE act on
 * prose, and a routing bug makes ADE answer for a panel that is not open —
 * and the second one is the plausible-looking failure, because the reply is
 * well-formed and simply untrue.
 *
 * A panel registers when it mounts and unregisters when it goes. Nothing is
 * remembered across that: an agent that asks the video panel to play after
 * the user closed it is told there is no video panel, which is a sentence it
 * can act on. Answering "ok" would leave it reasoning about a frame nobody
 * is showing.
 */

export interface PanelHandler {
  /** What this panel can be asked, for the greeting typed into a session. */
  readonly verbs: readonly PanelVerb[]
  run(request: PanelRequest): Promise<PanelOutcome>
}

export interface HandledRequest {
  readonly request: PanelRequest
  /** The single line to type back into the session that asked. */
  readonly reply: string
}

export interface PanelRouter {
  register(panel: string, handler: PanelHandler): void
  /**
   * Removes `panel`. With `handler`, only if that is still the one registered:
   * two panes of one kind share a name, and closing the older one must not
   * silence the one still open.
   */
  unregister(panel: string, handler?: PanelHandler): void
  /** The panels that can be driven right now, in the order they opened. */
  open(): string[]
  /**
   * Reads one line of agent output from session `from`.
   *
   * Resolves to `undefined` when the line was not a request at all, which is
   * almost every line — the caller must not treat that as a failure. Also
   * `undefined` for a line that is text ADE typed into that session coming
   * back as echo, and for a request the session showed within
   * `REPEAT_WINDOW_MS`: a TUI redraws its screen, and every redraw hands the
   * same line to `onLine` again.
   */
  handle(line: string, from?: string, now?: number): Promise<HandledRequest | undefined>
  /** Records text ADE typed into session `from`, so its echo is not read as the agent's. */
  typed(from: string, text: string, now?: number): void
  /** The lines that tell a session a panel exists. Empty when it does not. */
  greeting(panel: string): string[]
}

/** A request line seen again this soon after its last sighting is a redraw, not a new request. */
export const REPEAT_WINDOW_MS = 30_000
/** How long text ADE typed into a session can come back as its echo. */
export const ECHO_WINDOW_MS = 10 * 60_000
/** The most typed texts remembered per session. */
const MAX_TYPED = 32

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()

export function createPanelRouter(): PanelRouter {
  const handlers = new Map<string, PanelHandler>()
  const typedBy = new Map<string, { text: string; at: number }[]>()
  const seenBy = new Map<string, Map<string, number>>()

  /** Whether `raw` is part of something ADE typed into `from`, echoed or redrawn by its TUI. */
  const isEcho = (from: string, raw: string, now: number) =>
    (typedBy.get(from) ?? []).some((entry) => now - entry.at < ECHO_WINDOW_MS && entry.text.includes(raw))

  /** Whether `raw` was already seen in `from` within the window; each sighting restarts it. */
  const isRepeat = (from: string, raw: string, now: number) => {
    let seen = seenBy.get(from)
    if (!seen) seenBy.set(from, (seen = new Map()))
    const last = seen.get(raw)
    seen.set(raw, now)
    if (seen.size > 64) for (const [key, at] of seen) if (now - at >= REPEAT_WINDOW_MS) seen.delete(key)
    return last !== undefined && now - last < REPEAT_WINDOW_MS
  }

  return {
    register(panel, handler) {
      handlers.set(panel, handler)
    },

    unregister(panel, handler) {
      if (handler && handlers.get(panel) !== handler) return
      handlers.delete(panel)
    },

    open() {
      return [...handlers.keys()]
    },

    typed(from, text, now = Date.now()) {
      const entries = (typedBy.get(from) ?? []).filter((entry) => now - entry.at < ECHO_WINDOW_MS)
      entries.push({ text: normalize(text), at: now })
      typedBy.set(from, entries.slice(-MAX_TYPED))
    },

    async handle(line, from = "", now = Date.now()) {
      const request = parseRequest(line)
      if (!request) return undefined
      const raw = normalize(request.raw)
      if (isEcho(from, raw, now) || isRepeat(from, raw, now)) return undefined

      const handler = handlers.get(request.panel)
      if (!handler) {
        const open = [...handlers.keys()]
        const detail =
          open.length === 0
            ? "nessun pannello aperto"
            : `pannelli aperti: ${open.join(", ")}`
        return { request, reply: formatReply(request, { ok: false, reason: `«${request.panel}» non è aperto; ${detail}` }) }
      }

      try {
        return { request, reply: formatReply(request, await handler.run(request)) }
      } catch (error) {
        /*
         * A handler that throws still gets an answer typed back.
         *
         * The agent is waiting on a line. Letting the exception escape would
         * leave it waiting forever, which looks from the outside exactly like
         * an agent that has stopped thinking.
         */
        const reason = error instanceof Error && error.message ? error.message : "non riuscito"
        return { request, reply: formatReply(request, { ok: false, reason }) }
      }
    },

    greeting(panel) {
      const handler = handlers.get(panel)
      return handler ? describeCapabilities(panel, handler.verbs) : []
    },
  }
}
