/**
 * The chat turns running now, written down before each starts (BOT-5). The message is acknowledged at the start of its
 * turn, so a reload, a crash or the update that cuts the turn would leave the chat with no answer and nothing to run
 * again. What is still here when a page starts was cut, and the chat is told.
 */

import type { GatewayMessage } from "./controller"

export interface TurnsUnderWay {
  note: (key: string, message: GatewayMessage) => void
  done: (key: string) => void
  /** What was left by the page before, and forgotten here: each is told once. */
  take: () => (readonly [string, GatewayMessage])[]
}

export function memoryTurnsUnderWay(): TurnsUnderWay {
  const running = new Map<string, GatewayMessage>()
  return {
    note: (key, message) => void running.set(key, message),
    done: (key) => void running.delete(key),
    take: () => {
      const left = [...running]
      running.clear()
      return left
    },
  }
}

/** The renderer's key: one object, a key per `bot:platform:chat`, as the sessions. `forget.ts` takes a deleted bot's out. */
export const TURNS_UNDER_WAY_KEY = "ade.gateway.underWay"

function isMessage(value: unknown): value is GatewayMessage {
  if (!value || typeof value !== "object") return false
  const { bot, platform, chat, id, text, sender } = value as Record<string, unknown>
  return (
    [bot, platform, chat, id, text].every((field) => typeof field === "string") &&
    typeof (sender as { id?: unknown } | null)?.id === "string"
  )
}

/** In the renderer's storage: it has to outlive the page. Blocked storage only means the chat is not told. */
export function localTurnsUnderWay(key: string = TURNS_UNDER_WAY_KEY): TurnsUnderWay {
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
      // Nothing to do: the next page will not know this turn was running.
    }
  }
  return {
    note: (chat, message) => write({ ...read(), [chat]: message }),
    done: (chat) => {
      const { [chat]: _gone, ...rest } = read()
      write(rest)
    },
    take: () => {
      const left = Object.entries(read()).filter((entry): entry is [string, GatewayMessage] => isMessage(entry[1]))
      write({})
      return left
    },
  }
}
