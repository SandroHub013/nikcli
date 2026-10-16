import { currentAgentId } from "../../session/legacy-agent-id"
/**
 * A chat's conversation with a bot, across turns (G4).
 *
 * Each chat a bot answers through its gateway is its own conversation: the
 * CLI's session id is kept per chat under one key, so the next message
 * continues where the last turn left off, and `/nuova` forgets it. Apart
 * from the Bots panel's thread with the same bot: a message from the phone
 * does not land in the conversation on screen, nor the other way round.
 *
 * A session belongs to one CLI in one folder: it is kept with the project and
 * the runner it ran in, and one saved for another is not continued (G4
 * review, BASSO 2). The gateway switched on for another project, or the bot
 * moved to another CLI, starts a new conversation instead of failing on
 * every message until `/nuova`.
 */

/** The one place a chat's key is made: `bot:platform:chat[:thread]`. */
export function sessionKey(bot: string, platform: string, chat: string, thread?: string): string {
  return [bot, platform, chat, ...(thread ? [thread] : [])].join(":")
}

export interface ChatSession {
  readonly project: string
  readonly runner: string
  readonly sessionId: string
  /** The words that opened the conversation, short: how `/sessioni` names it. */
  readonly title?: string
  /** When the conversation last had a turn. */
  readonly at?: number
}

/** The title of a conversation: its first line, on one line, short. */
export function sessionTitle(text: string): string {
  const line = (text.split(/\r?\n/).find((each) => each.trim()) ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  const chars = [...line]
  return chars.length > 40 ? `${chars.slice(0, 39).join("")}…` : line
}

/** The CLI session each chat continues. */
export interface SessionStore {
  get: (key: string) => ChatSession | undefined
  set: (key: string, session: ChatSession) => void
  forget: (key: string) => void
}

/** The session id to continue, if the saved session ran in this project on this runner. */
export function resumable(saved: ChatSession | undefined, project: string, runner: string): string | undefined {
  return saved && saved.project === project && saved.runner === runner ? saved.sessionId : undefined
}

/** A saved session as far as it can be trusted; one saved before this shape is none. */
function parse(value: unknown): ChatSession | undefined {
  if (!value || typeof value !== "object") return undefined
  const { project, runner, sessionId, title, at } = value as Record<string, unknown>
  return typeof project === "string" && typeof runner === "string" && typeof sessionId === "string" && sessionId
    ? {
        project,
        runner: currentAgentId(runner),
        sessionId,
        ...(typeof title === "string" ? { title: sessionTitle(title) } : {}),
        ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
      }
    : undefined
}

const STORAGE_KEY = "ade.gateway.sessions"

/** In the renderer's storage, so a conversation survives ADE restarting. */
export function localSessionStore(key: string = STORAGE_KEY): SessionStore {
  const read = (): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  const write = (all: Record<string, unknown>) => {
    try {
      localStorage.setItem(key, JSON.stringify(all))
    } catch {
      // Storage blocked: the conversation lasts until ADE closes.
    }
  }
  return {
    get: (chat) => parse(read()[chat]),
    set: (chat, session) => write({ ...read(), [chat]: session }),
    forget: (chat) => {
      const { [chat]: _gone, ...rest } = read()
      write(rest)
    },
  }
}

export function memorySessionStore(): SessionStore {
  const sessions = new Map<string, ChatSession>()
  return {
    get: (key) => sessions.get(key),
    set: (key, session) => void sessions.set(key, session),
    forget: (key) => void sessions.delete(key),
  }
}

/** How many past conversations a chat keeps to resume. */
export const HISTORY_PER_CHAT = 5

/**
 * The conversations a chat left with `/nuova` or `/sessioni`, newest first, for `/sessioni` to list. Each is the CLI's
 * session id with the project and runner it ran in, so it is only resumed where it can be (`resumable`).
 */
export interface HistoryStore {
  list: (key: string) => ChatSession[]
  /** Keeps `past` as the newest; returns the ones the cap pushed out. */
  add: (key: string, past: ChatSession) => ChatSession[]
  remove: (key: string, sessionId: string) => void
  /** Takes the chat's whole history away; returns what it held. */
  clear: (key: string) => ChatSession[]
}

function rememberPast(list: readonly ChatSession[], past: ChatSession): { kept: ChatSession[]; pushedOut: ChatSession[] } {
  const all = [past, ...list.filter((each) => each.sessionId !== past.sessionId)]
  return { kept: all.slice(0, HISTORY_PER_CHAT), pushedOut: all.slice(HISTORY_PER_CHAT) }
}

const HISTORY_KEY = "ade.gateway.history"

/** In the renderer's storage, next to the sessions. */
export function localHistoryStore(key: string = HISTORY_KEY): HistoryStore {
  const read = (): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  const write = (all: Record<string, unknown>) => {
    try {
      localStorage.setItem(key, JSON.stringify(all))
    } catch {
      // Storage blocked: the history lasts until ADE closes.
    }
  }
  const listOf = (all: Record<string, unknown>, chat: string): ChatSession[] => {
    const value = all[chat]
    return Array.isArray(value) ? value.map(parse).filter((each) => each !== undefined) : []
  }
  return {
    list: (chat) => listOf(read(), chat),
    add: (chat, past) => {
      const all = read()
      const { kept, pushedOut } = rememberPast(listOf(all, chat), past)
      write({ ...all, [chat]: kept })
      return pushedOut
    },
    remove: (chat, sessionId) => {
      const all = read()
      write({ ...all, [chat]: listOf(all, chat).filter((each) => each.sessionId !== sessionId) })
    },
    clear: (chat) => {
      const { [chat]: gone, ...rest } = read()
      write(rest)
      return Array.isArray(gone) ? gone.map(parse).filter((each) => each !== undefined) : []
    },
  }
}

export function memoryHistoryStore(): HistoryStore {
  const all = new Map<string, ChatSession[]>()
  return {
    list: (key) => [...(all.get(key) ?? [])],
    add: (key, past) => {
      const { kept, pushedOut } = rememberPast(all.get(key) ?? [], past)
      all.set(key, kept)
      return pushedOut
    },
    remove: (key, sessionId) => void all.set(key, (all.get(key) ?? []).filter((each) => each.sessionId !== sessionId)),
    clear: (key) => {
      const gone = all.get(key) ?? []
      all.delete(key)
      return gone
    },
  }
}
