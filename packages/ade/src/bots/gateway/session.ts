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
  const { project, runner, sessionId } = value as Record<string, unknown>
  return typeof project === "string" && typeof runner === "string" && typeof sessionId === "string" && sessionId
    ? { project, runner, sessionId }
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
