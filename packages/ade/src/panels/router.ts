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
  /** `from` is the session that wrote the request, for a panel that answers each session apart. */
  run(request: PanelRequest, from?: string): Promise<PanelOutcome>
}

export type HandledRequest =
  | {
      readonly request: PanelRequest
      /** The single line to type back into the session that asked. */
      readonly reply: string
    }
  | {
      readonly request: PanelRequest
      /**
       * The request was not run, and this says why, for the transcript only.
       * Typing it back would make the TUI redraw, and the line come again.
       */
      readonly skipped: string
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
   * almost every line — the caller must not treat that as a failure.
   *
   * Not run, and answered with `skipped` instead: text ADE typed into that
   * session in the last `ECHO_WINDOW_MS` coming back as echo, and a request
   * the session showed within `REPEAT_WINDOW_MS` of this turn — a TUI
   * redraws its screen, and every redraw hands the same line to `onLine`
   * again. Only the first skip of a run says so; the rest are `undefined`.
   */
  handle(line: string, from?: string, now?: number): Promise<HandledRequest | undefined>
  /** Records text ADE typed into session `from`, so its echo is not read as the agent's. */
  typed(from: string, text: string, now?: number): void
  /**
   * Session `from` started a turn of its own: the user or a message typed
   * into it, or its hook said busy. A request it repeats from now on is a new
   * one. Ignored within `ECHO_WINDOW_MS` of a panel reply, whose typing is
   * what started that turn and whose redraw would bring the old line back.
   */
  newTurn(from: string, now?: number): void
  /** The lines that tell a session a panel exists. Empty when it does not. */
  greeting(panel: string): string[]
}

/** A request line seen again this soon after its last sighting is a redraw, not a new request. */
export const REPEAT_WINDOW_MS = 30_000

/**
 * Why a panel's answer may not be typed into its session right now, or
 * `undefined` when it may.
 *
 * A panel reply is a line like any other, and it used not to be one: it went
 * straight into the pty with its Enter, past the line queue, past the draft
 * check and past the permission check. So an agent that printed an `@ade` line
 * and then asked for a permission had its answer typed over the prompt and
 * Entered, which confirms the selected choice — and when the options are
 * numbered, a reply that starts with a digit picks one of them instead. The
 * answer is the one thing here that cannot be late: the agent is blocked on its
 * own stdin, waiting for it, which is also why a held reply is retried instead
 * of dropped.
 *
 * The three reasons, in the order they are asked: there is no session to type
 * into, the user has a line of their own begun in the box, or a question is open
 * — from the screen or from the hook, which is the same question the screen
 * sometimes misses (`isQuestionOpen`).
 */
export function panelReplyHold(from: { alive: boolean; typing: boolean; questionOpen: boolean }): string | undefined {
  if (!from.alive) return "sessione chiusa"
  if (from.typing) return "riga iniziata"
  if (from.questionOpen) return "prompt aperto"
  return undefined
}

/** How long a panel answer may wait for its pane before it is given up on. */
export const PANEL_REPLY_MAX_AGE_MS = 5 * 60_000

/**
 * Whether dictated words may be written into a pane's line, and why not when they
 * may not.
 *
 * Dictation sends no Enter, so it confirms nothing by itself: this is not the
 * Enter that answers a prompt. It is where the text lands. A permission menu
 * takes what is written as an answer, and a menu of numbered options takes a
 * digit as the choice — through its own reading of the line rather than through
 * a pane's Enter, which is the same accident by another road. The review that
 * found this had not watched it happen, so the argument is from the menu, not
 * from an observation; a guard that costs a line, is silent when there is no
 * question, and takes nothing from the user is worth more than the doubt.
 *
 * So the words are not written and the pane says why: the user answers with the
 * keys or the card's buttons, and dictates again after. A line the user has
 * begun is not a reason: dictated words have always joined it, and that is not
 * what this is about.
 */
export function dictationHold(from: { alive: boolean; questionOpen: boolean }): string | undefined {
  if (!from.alive) return "sessione chiusa"
  if (from.questionOpen) return "prompt aperto"
  return undefined
}

/** One answer waiting, and the moment it was made: the age is counted from there, not from the last try. */
export interface PanelReplyWait {
  text: string
  at: number
}

/**
 * The panel answers waiting for their pane.
 *
 * A pane is not a session: restarting or resuming it keeps the id and gives a new
 * process, and an answer made for the old one would arrive at a session that
 * never asked for it and start a turn there. So the session is stored with the
 * answer, and the whole entry is dropped when the pane's session is not the one
 * that asked — which is what "it dies with the pane" has to mean to be true.
 *
 * A list and not a single answer, because two `@ade` lines in a row while a
 * prompt is open are two answers and the second does not cancel the first. They
 * go in the order they were made, which is the order the agent asked.
 *
 * And an age, because a TUI does not sit blocked on its input the way a pipe
 * does: after the permission is answered the turn carries on and ends, and the
 * agent may be long past needing the reply. Typing it then is not a safety
 * problem — the guard still holds — but it is a turn nobody asked for, and it
 * costs. Five minutes is long enough for a user who stepped away from an open
 * prompt and short enough that the answer is still about the same conversation.
 * The answer is already in the transcript, so dropping it loses the record and
 * not the text.
 */
export interface PendingPanelReplies<S> {
  /**
   * A new answer for a pane that is free: written out at once when nothing is
   * waiting for it, and queued at the end when something is.
   *
   * That is the whole of the ordering rule, and it is here rather than in the
   * caller so that a test can reach it. Writing straight out with answers already
   * waiting does two wrong things at once: the new answer overtakes the old ones,
   * and if it then cannot be given it is dropped, because the check that used to
   * follow saw the *older* answers waiting and read them as a reason to leave
   * this one out. The list exists so that the second answer does not cancel the
   * first, and an answer that skips the list is the same bug wearing a hat.
   *
   * True when the caller may write it now; false when it has been queued instead.
   */
  admit(paneId: string, session: S, text: string, now?: number): boolean
  /** Waits an answer for `session`, after the ones already waiting for it. */
  queue(paneId: string, session: S, text: string, now?: number): void
  /** Takes one answer out, so the round sending it cannot send it twice. True when it was there. */
  take(paneId: string, text: string): boolean
  /**
   * Puts an answer back after a try that did not give it, keeping the age it was
   * made at **and the place that age puts it in**: the round sends waiting answers
   * in the order they were made, so an answer restored to the back would be
   * overtaken by the ones asked after it.
   */
  restore(paneId: string, session: S, text: string, at: number): void
  /**
   * The answers still young enough to send, and how many were too old and are now
   * gone. Ageing happens here and not on the way in, so a pane that stays busy
   * for an hour still gives up its answers instead of keeping them for ever.
   */
  claim(paneId: string, now?: number): { waits: PanelReplyWait[]; stale: number }
  /** The session that asked for the answers waiting on `paneId`. */
  sessionOf(paneId: string): S | undefined
  /** The answers waiting on `paneId`, in the order they were made. */
  waiting(paneId: string): PanelReplyWait[]
  /** Every pane with something waiting. */
  panes(): string[]
  forget(paneId: string): void
}

export function createPendingPanelReplies<S>(): PendingPanelReplies<S> {
  const entries = new Map<string, { session: S; waits: PanelReplyWait[] }>()
  return {
    admit(paneId, session, text, now = Date.now()) {
      if (entries.get(paneId)?.waits.length) {
        this.queue(paneId, session, text, now)
        return false
      }
      return true
    },
    queue(paneId, session, text, now = Date.now()) {
      const entry = entries.get(paneId)
      // A different session on the same pane: the old answers were for a process
      // that is gone, and the new one has not asked for them.
      if (!entry || entry.session !== session) entries.set(paneId, { session, waits: [{ text, at: now }] })
      else entry.waits.push({ text, at: now })
    },
    take(paneId, text) {
      const entry = entries.get(paneId)
      if (!entry) return false
      const before = entry.waits.length
      entry.waits = entry.waits.filter((wait) => wait.text !== text)
      if (entry.waits.length === 0) entries.delete(paneId)
      return entry.waits.length < before
    },
    restore(paneId, session, text, at) {
      const entry = entries.get(paneId)
      // A pane that restarted while the try was in flight: the answer is for the
      // process that asked, and that one is not this one.
      if (entry && entry.session !== session) return
      if (entry?.waits.some((wait) => wait.text === text)) return
      // The entry may be gone: taking the last answer out empties it, and this is
      // that answer coming back because the try did not give it.
      if (!entry) {
        entries.set(paneId, { session, waits: [{ text, at }] })
        return
      }
      /*
       * Back where it was made, and not at the end of the list.
       *
       * Appending looks harmless and is not: a held answer goes to the back, so
       * the round after this one sends the answers asked *after* it first, and
       * the agent reads the reply to its second question before the reply to its
       * first. Stopping the round at the first held answer only postpones that by
       * one round — the order has to be put back here as well, or the break just
       * moves the inversion instead of removing it.
       */
      const later = entry.waits.findIndex((wait) => wait.at > at)
      if (later < 0) entry.waits.push({ text, at })
      else entry.waits.splice(later, 0, { text, at })
    },
    claim(paneId, now = Date.now()) {
      const entry = entries.get(paneId)
      if (!entry) return { waits: [], stale: 0 }
      const waits = entry.waits.filter((wait) => now - wait.at <= PANEL_REPLY_MAX_AGE_MS)
      const stale = entry.waits.length - waits.length
      entry.waits = waits
      if (waits.length === 0) entries.delete(paneId)
      return { waits, stale }
    },
    sessionOf: (paneId) => entries.get(paneId)?.session,
    waiting: (paneId) => entries.get(paneId)?.waits.map((wait) => ({ ...wait })) ?? [],
    panes: () => [...entries.keys()],
    forget: (paneId) => void entries.delete(paneId),
  }
}

/**
 * How long text ADE typed into a session can come back as its echo.
 *
 * Seconds, not minutes: a message that quoted `@ade model state` ten minutes
 * ago must not swallow the agent writing it now. A TUI that keeps redrawing
 * the echo past this is caught as a repeat, since the echo was seen.
 */
export const ECHO_WINDOW_MS = 5_000
/** The most typed texts remembered per session. */
const MAX_TYPED = 32

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()

/** `clock` is only for tests: it tells how long a handler took. */
export function createPanelRouter(clock: () => number = Date.now): PanelRouter {
  const handlers = new Map<string, PanelHandler>()
  const typedBy = new Map<string, { text: string; at: number }[]>()
  /** Each request line a session showed this turn: when last, and whether its skip was already said. */
  const seenBy = new Map<string, Map<string, { at: number; noted: boolean }>>()
  const repliedAt = new Map<string, number>()

  /** Whether `raw` is part of something ADE just typed into `from`, echoed by its TUI. */
  const isEcho = (from: string, raw: string, now: number) =>
    (typedBy.get(from) ?? []).some((entry) => now - entry.at < ECHO_WINDOW_MS && entry.text.includes(raw))

  const seenIn = (from: string, now: number) => {
    let seen = seenBy.get(from)
    if (!seen) seenBy.set(from, (seen = new Map()))
    if (seen.size > 64) for (const [key, entry] of seen) if (now - entry.at >= REPEAT_WINDOW_MS) seen.delete(key)
    return seen
  }

  const answer = async (request: PanelRequest, from: string): Promise<string> => {
    const handler = handlers.get(request.panel)
    if (!handler) {
      const open = [...handlers.keys()]
      const detail =
        open.length === 0
          ? "nessun pannello aperto"
          : `pannelli aperti: ${open.join(", ")}`
      return formatReply(request, { ok: false, reason: `«${request.panel}» non è aperto; ${detail}` })
    }

    try {
      return formatReply(request, await handler.run(request, from || undefined))
    } catch (error) {
      /*
       * A handler that throws still gets an answer typed back.
       *
       * The agent is waiting on a line. Letting the exception escape would
       * leave it waiting forever, which looks from the outside exactly like
       * an agent that has stopped thinking.
       */
      const reason = error instanceof Error && error.message ? error.message : "non riuscito"
      return formatReply(request, { ok: false, reason })
    }
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

    newTurn(from, now = Date.now()) {
      if (now - (repliedAt.get(from) ?? -Infinity) < ECHO_WINDOW_MS) return
      seenBy.delete(from)
    },

    async handle(line, from = "", now = Date.now()) {
      const request = parseRequest(line)
      if (!request) return undefined
      const raw = normalize(request.raw)
      const seen = seenIn(from, now)
      const last = seen.get(raw)
      const echo = isEcho(from, raw, now)
      const repeat = last !== undefined && now - last.at < REPEAT_WINDOW_MS
      if (echo || repeat) {
        seen.set(raw, { at: now, noted: true })
        if (repeat && last?.noted) return undefined
        const why = echo
          ? "è l'eco di un testo che ADE ha appena scritto nella sessione"
          : `è uguale a una di meno di ${REPEAT_WINDOW_MS / 1000} s fa in questo turno, come nel ridisegno di una TUI`
        return { request, skipped: `Riga non eseguita: ${raw} — ${why}` }
      }
      seen.set(raw, { at: now, noted: false })
      const started = clock()
      const reply = await answer(request, from)
      // When the reply is typed, not when the request came: a capture can take
      // seconds, and the busy that the reply causes must still fall within the window.
      repliedAt.set(from, now + (clock() - started))
      return { request, reply }
    },

    greeting(panel) {
      const handler = handlers.get(panel)
      return handler ? describeCapabilities(panel, handler.verbs) : []
    },
  }
}
