/**
 * Whether a bot from the open project may run (B3, audit A4).
 *
 * A bot in the project's `.nikcli/agent/` is a file the repository's author
 * wrote: a cloned repository can bring one, with a persona and settings
 * meant to do something the user never asked for. It runs on the user's own
 * plan, in the user's folder. So the first time it is used the user is asked,
 * and the answer holds for that exact file: the SHA-256 of its contents. When
 * the file changes, the question comes back. The user's own bots (global
 * scope) are never asked about.
 *
 * What a trusted repository bot may do is still less than one the user wrote:
 * see `fromRepository` in `runners.ts`.
 */

import type { AgentFile } from "./nikcli"
import { t } from "../i18n"

/** The trusted fingerprint of each file, by path. */
export interface TrustStore {
  get: (path: string) => string | undefined
  set: (path: string, fingerprint: string) => void
}

const STORAGE_KEY = "ade.bots.trusted"

/** In the renderer's storage: a trust given on this machine, by this user. */
export function localTrustStore(): TrustStore {
  const read = (): Record<string, string> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
    } catch {
      return {}
    }
  }
  return {
    get: (path) => {
      const value = read()[path]
      return typeof value === "string" ? value : undefined
    },
    set: (path, fingerprint) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...read(), [path]: fingerprint }))
      } catch {
        // Storage blocked: the trust lasts until the file is asked about again.
      }
    },
  }
}

/** For tests, and wherever nothing should outlive the process. */
export function memoryTrustStore(): TrustStore {
  const trusted = new Map<string, string>()
  return { get: (path) => trusted.get(path), set: (path, fingerprint) => void trusted.set(path, fingerprint) }
}

/** SHA-256 of `text`, in hex. */
export async function fileFingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export interface AdmitDeps {
  readonly store: TrustStore
  /** The bot file's contents as they are now. */
  readonly read: (path: string) => Promise<string>
  /** Asks the user; true is yes. */
  readonly confirm: (question: string) => boolean | Promise<boolean>
}

/**
 * Whether `bot` may take a turn now. A user's bot always may; a project's
 * bot may once its file, as it is now, was trusted — asked here when it was
 * not, and remembered on a yes.
 */
export async function admit(bot: AgentFile, deps: AdmitDeps): Promise<{ ok: true } | { ok: false; problem?: string }> {
  if (bot.scope !== "project") return { ok: true }
  let text: string
  try {
    text = await deps.read(bot.path)
  } catch {
    return { ok: false, problem: t("bots.trust.unreadable", bot.identifier) }
  }
  const fingerprint = await fileFingerprint(text)
  const trusted = deps.store.get(bot.path)
  if (trusted === fingerprint) return { ok: true }
  const question = trusted === undefined ? t("bots.trust.new", bot.identifier) : t("bots.trust.changed", bot.identifier)
  if (!(await deps.confirm(question))) return { ok: false }
  deps.store.set(bot.path, fingerprint)
  return { ok: true }
}
