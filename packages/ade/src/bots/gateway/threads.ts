/**
 * A gateway chat's thread, kept apart from the one on the Bot panel (G7).
 *
 * The panel's thread is the person at the keyboard. A chat that reaches the
 * same bot from outside is another conversation, so it has its own key:
 * one per bot, platform and chat. What is written uses the panel's archive:
 * tool output is cut, obvious keys are replaced, and the whole thread stays
 * under the same size. A reload reads it back.
 */

import { emptyTalk, parseTalk, serializeTalk, type Talk } from "../talk"
import { sessionKey } from "./session"

/** Where one chat's thread is kept. The session key, so two chats never share it. */
export function gatewayThreadKey(bot: string, platform: string, chat: string, thread?: string): string {
  return `ade.gateway.talk\n${sessionKey(bot, platform, chat, thread)}`
}

export interface ThreadDisk {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The thread a chat continues: what was already said, then this turn. */
export function keptThread(previous: Talk, turn: Talk): Talk {
  return {
    messages: [...previous.messages, ...turn.messages],
    status: "idle",
    tokens: previous.tokens + turn.tokens,
    costUsd: previous.costUsd + turn.costUsd,
    ...((turn.sessionId ?? previous.sessionId) ? { sessionId: turn.sessionId ?? previous.sessionId } : {}),
    ...((turn.updatedAt ?? previous.updatedAt) ? { updatedAt: turn.updatedAt ?? previous.updatedAt } : {}),
  }
}

export interface GatewayThreads {
  read(key: string): Talk
  /** Writes the thread once, scrubbed and capped. */
  save(key: string, talk: Talk): void
  forget(key: string): void
}

export function createGatewayThreads(disk: ThreadDisk): GatewayThreads {
  return {
    read(key) {
      try {
        return parseTalk(disk.getItem(key))
      } catch {
        return emptyTalk()
      }
    },
    save(key, talk) {
      try {
        disk.setItem(key, serializeTalk(talk))
      } catch {
        // Quota, or storage blocked. The chat still gets its answer.
      }
    },
    forget(key) {
      try {
        disk.removeItem(key)
      } catch {
        // A thread left behind is read again; /nuova still forgot the CLI session.
      }
    },
  }
}
