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
  unregister(panel: string): void
  /** The panels that can be driven right now, in the order they opened. */
  open(): string[]
  /**
   * Reads one line of agent output.
   *
   * Resolves to `undefined` when the line was not a request at all, which is
   * almost every line — the caller must not treat that as a failure.
   */
  handle(line: string): Promise<HandledRequest | undefined>
  /** The lines that tell a session a panel exists. Empty when it does not. */
  greeting(panel: string): string[]
}

export function createPanelRouter(): PanelRouter {
  const handlers = new Map<string, PanelHandler>()

  return {
    register(panel, handler) {
      handlers.set(panel, handler)
    },

    unregister(panel) {
      handlers.delete(panel)
    },

    open() {
      return [...handlers.keys()]
    },

    async handle(line) {
      const request = parseRequest(line)
      if (!request) return undefined

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
