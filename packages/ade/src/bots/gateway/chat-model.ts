/**
 * The model a chat chose for its bot with `/modello` (choice 9).
 *
 * It holds for that chat alone, and it is only ever one of the bot's own: the models of the CLI the bot runs on, or,
 * for ragu, the free ones in its catalog. A phone cannot pick a paid ragu model: the daily cap counts what a turn
 * spent, it does not ask first. What is kept is the model with the runner it was chosen for, so a bot moved to another
 * CLI goes back to its own model instead of being given an id that CLI does not know.
 */

import type { AgentFile } from "../ragu"
import { isFreeModel } from "../../chat/model"
import { runnerById } from "../runners"

/** How many models `/modello` offers at most: a list one reads on a phone. */
export const MODEL_CHOICES_MAX = 8

export interface ChatModel {
  readonly runner: string
  readonly model: string
}

/** The model each chat chose, by the chat's key (`sessionKey`). */
export interface ChatModelStore {
  get: (key: string) => ChatModel | undefined
  set: (key: string, chosen: ChatModel) => void
  forget: (key: string) => void
}

/** A model id as a CLI takes it on its command line: no space, no quote, no option. */
const SAFE_MODEL = /^[A-Za-z0-9][\w.:/@~-]{0,119}$/

/** A saved choice as far as it can be trusted; anything else is none. */
function parse(value: unknown): ChatModel | undefined {
  if (!value || typeof value !== "object") return undefined
  const { runner, model } = value as Record<string, unknown>
  return typeof runner === "string" && typeof model === "string" && SAFE_MODEL.test(model) ? { runner, model } : undefined
}

const STORAGE_KEY = "ade.gateway.models"

/** In the renderer's storage, so the choice survives ADE restarting. */
export function localChatModelStore(key: string = STORAGE_KEY): ChatModelStore {
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
      // Storage blocked: the choice lasts until ADE closes.
    }
  }
  return {
    get: (chat) => parse(read()[chat]),
    set: (chat, chosen) => write({ ...read(), [chat]: chosen }),
    forget: (chat) => {
      const { [chat]: _gone, ...rest } = read()
      write(rest)
    },
  }
}

export function memoryChatModelStore(): ChatModelStore {
  const chosen = new Map<string, ChatModel>()
  return {
    get: (key) => chosen.get(key),
    set: (key, model) => void chosen.set(key, model),
    forget: (key) => void chosen.delete(key),
  }
}

/** The bot as the chat runs it: with the model the chat chose, if that was chosen for the runner the bot is on now. */
export function botForChat(bot: AgentFile, chosen: ChatModel | undefined): AgentFile {
  return chosen && chosen.runner === runnerById(bot.runner).id ? { ...bot, model: chosen.model } : bot
}

/**
 * The models a chat may choose for `bot`, the bot's own first: its CLI's list, or, on ragu, the free models of
 * `catalog` (ragu's `provider/model` ids). At most `MODEL_CHOICES_MAX`, each once.
 */
export function modelChoices(bot: AgentFile, catalog: readonly string[]): string[] {
  const runner = runnerById(bot.runner)
  const offered = runner.id === "ragu" ? catalog.filter((id) => isFreeModel({ id })) : runner.models
  const seen = new Set<string>()
  const out: string[] = []
  // The bot's own model even when a ragu bot's is a paid one: it is there to go back to, the owner chose it.
  for (const id of [...(bot.model ? [bot.model] : []), ...offered]) {
    if (!SAFE_MODEL.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MODEL_CHOICES_MAX) break
  }
  return out
}
