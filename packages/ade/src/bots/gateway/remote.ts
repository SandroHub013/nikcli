/**
 * «Comandi da remoto», per bot (G5, D93).
 *
 * Off by default: a turn from a chat has no shell. The owner turns it on for
 * one bot, in ADE (the panel, G6), and never from a chat. With it on, nikcli
 * asks about every command on the phone; Claude Code, which cannot ask
 * mid-turn, runs only the commands listed here.
 *
 * Kept in the renderer's storage, by the bot file's path: a file cannot turn
 * it on for itself, a repository least of all.
 */

import { safeCommandPattern, type RemoteTools } from "../runners"

export interface RemoteStore {
  get: (bot: string) => RemoteTools
  set: (bot: string, tools: RemoteTools) => void
}

export const REMOTE_OFF: RemoteTools = { commands: false, allowed: [] }

const STORAGE_KEY = "ade.gateway.remote"

/** What was saved, as far as it can be trusted: anything unexpected is off. */
function parse(value: unknown): RemoteTools {
  if (!value || typeof value !== "object") return REMOTE_OFF
  const { commands, allowed } = value as { commands?: unknown; allowed?: unknown }
  return {
    commands: commands === true,
    allowed: Array.isArray(allowed) ? allowed.filter((item): item is string => typeof item === "string" && safeCommandPattern(item)) : [],
  }
}

export function localRemoteStore(key: string = STORAGE_KEY): RemoteStore {
  const read = (): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return {
    get: (bot) => parse(read()[bot]),
    set: (bot, tools) => {
      try {
        localStorage.setItem(key, JSON.stringify({ ...read(), [bot]: parse(tools) }))
      } catch {
        // Storage blocked: the setting lasts until ADE closes, off after.
      }
    },
  }
}

export function memoryRemoteStore(): RemoteStore {
  const saved = new Map<string, RemoteTools>()
  return { get: (bot) => saved.get(bot) ?? REMOTE_OFF, set: (bot, tools) => void saved.set(bot, parse(tools)) }
}
