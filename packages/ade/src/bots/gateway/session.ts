/**
 * A chat's conversation with a bot, across turns (G4).
 *
 * Each chat a bot answers through its gateway is its own conversation: the
 * CLI's session id is kept per chat under one key, so the next message
 * continues where the last turn left off, and `/nuova` forgets it. Apart
 * from the Bots panel's thread with the same bot: a message from the phone
 * does not land in the conversation on screen, nor the other way round.
 */

/** The one place a chat's key is made: `bot:platform:chat[:thread]`. */
export function sessionKey(bot: string, platform: string, chat: string, thread?: string): string {
  return [bot, platform, chat, ...(thread ? [thread] : [])].join(":")
}

/** The CLI session each chat continues. */
export interface SessionStore {
  get: (key: string) => string | undefined
  set: (key: string, sessionId: string) => void
  forget: (key: string) => void
}

const STORAGE_KEY = "ade.gateway.sessions"

/** In the renderer's storage, so a conversation survives ADE restarting. */
export function localSessionStore(key: string = STORAGE_KEY): SessionStore {
  const read = (): Record<string, string> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
    } catch {
      return {}
    }
  }
  const write = (all: Record<string, string>) => {
    try {
      localStorage.setItem(key, JSON.stringify(all))
    } catch {
      // Storage blocked: the conversation lasts until ADE closes.
    }
  }
  return {
    get: (chat) => {
      const value = read()[chat]
      return typeof value === "string" ? value : undefined
    },
    set: (chat, sessionId) => write({ ...read(), [chat]: sessionId }),
    forget: (chat) => {
      const { [chat]: _gone, ...rest } = read()
      write(rest)
    },
  }
}

export function memorySessionStore(): SessionStore {
  const sessions = new Map<string, string>()
  return {
    get: (key) => sessions.get(key),
    set: (key, sessionId) => void sessions.set(key, sessionId),
    forget: (key) => void sessions.delete(key),
  }
}
