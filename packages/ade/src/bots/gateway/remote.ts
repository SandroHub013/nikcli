/**
 * «Comandi da remoto», per bot (G5, D93).
 *
 * Off by default: a turn from a chat has no shell. The owner turns it on for
 * one bot, in ADE (the panel, G6), and never from a chat. With it on, nikcli
 * asks about every command on the phone. Offered for nikcli only: Claude Code
 * and Codex cannot ask mid-turn, and from a chat they never have a shell.
 *
 * Kept in the renderer's storage, by the bot file's path: a file cannot turn
 * it on for itself, a repository least of all. With the file's fingerprint as
 * it was when the owner said yes: another file at the same path (a checkout,
 * an edit) finds it off (G5 review, BASSO 1).
 */

import { runnerById, type RemoteTools } from "../runners"

/** The switch as saved: on for the file whose fingerprint (`fileFingerprint`) it carries. */
export interface RemoteSetting {
  readonly commands: boolean
  readonly fingerprint?: string
}

export interface RemoteStore {
  get: (bot: string) => RemoteSetting
  set: (bot: string, setting: RemoteSetting) => void
}

export const REMOTE_OFF: RemoteTools = { commands: false }

/** The tools of a turn of the bot whose file is now `fingerprint`: on only for the file said yes to. */
export function remoteTools(setting: RemoteSetting | undefined, fingerprint: string | undefined): RemoteTools {
  return setting?.commands === true && setting.fingerprint !== undefined && setting.fingerprint === fingerprint
    ? { commands: true }
    : REMOTE_OFF
}

/** Whether the switch means anything for a bot on `runner`: the panel offers it only then. */
export function offersRemoteCommands(runner: string | undefined): boolean {
  return runnerById(runner).id === "nikcli"
}

const STORAGE_KEY = "ade.gateway.remote"

/** What was saved, as far as it can be trusted: anything unexpected, or on for no file, is off. */
function parse(value: unknown): RemoteSetting {
  if (!value || typeof value !== "object") return REMOTE_OFF
  const { commands, fingerprint } = value as { commands?: unknown; fingerprint?: unknown }
  return commands === true && typeof fingerprint === "string" && fingerprint ? { commands: true, fingerprint } : REMOTE_OFF
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
    set: (bot, setting) => {
      try {
        localStorage.setItem(key, JSON.stringify({ ...read(), [bot]: parse(setting) }))
      } catch {
        // Storage blocked: the setting lasts until ADE closes, off after.
      }
    },
  }
}

export function memoryRemoteStore(): RemoteStore {
  const saved = new Map<string, RemoteSetting>()
  return { get: (bot) => saved.get(bot) ?? REMOTE_OFF, set: (bot, setting) => void saved.set(bot, parse(setting)) }
}
