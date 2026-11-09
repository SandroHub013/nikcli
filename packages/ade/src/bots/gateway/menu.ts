/**
 * The menu of commands a messaging app shows next to its message box (Telegram's `/`).
 *
 * The commands are `policy.ts`'s; their words are ADE's language. One menu per bot: it is put on the app once the bot's
 * gateway is ready (running and connected), again each time the gateway comes up, and again when the language changes.
 * Rust remembers what an adapter already sent, so asking twice costs nothing there; here, a list already given to a gateway
 * that has not restarted is not asked again either.
 */

import type { Locale } from "../../i18n"
import { chatMenu, type MenuEntry } from "./policy"

/** The platforms that have a menu to put commands in. */
export const MENU_PLATFORMS: readonly string[] = ["telegram"]

/** A gateway as `gateway_status` and `gateway:status` say it. */
export interface MenuLink {
  readonly bot: string
  readonly platform: string
  readonly running: boolean
  readonly connected: boolean
}

export interface MenuDeps {
  readonly statuses: () => Promise<readonly MenuLink[]>
  /** Every change of a gateway, as it happens; resolves with the way to stop. */
  readonly onStatus: (handler: (link: MenuLink) => void) => Promise<() => void>
  readonly set: (bot: string, platform: string, commands: readonly MenuEntry[]) => Promise<void>
  /** The language now. */
  readonly language: () => Locale
  /** Calls `changed` each time the language changes (not when it starts); returns the way to stop. */
  readonly watchLanguage: (changed: () => void) => () => void
  /** Where a refused or unreachable menu is noted; never a token. */
  readonly warn?: (line: string) => void
  /** The time in milliseconds, for the minute a refused menu waits; `Date.now` unless a test sets it. */
  readonly now?: () => number
}

/** How long a list that could not be put waits before the next status asks again. */
const RETRY_AFTER_MS = 60_000

interface Known {
  /** The gateway is up and reading. */
  ready: boolean
  /** The list the app accepted since it came up. */
  given?: string
  /** The list being put now: a status heard meanwhile does not put it a second time. */
  inFlight?: string
  /** Counts the times the gateway came up: an attempt that was made for an earlier adapter does not touch what is known now. */
  epoch?: number
  /** A list that failed, and when the next status may try it again: a changed list is tried at once. */
  failed?: { key: string; retryAt: number }
}

/** Starts keeping the menus; resolves with the way to stop. */
export async function startMenuSync(deps: MenuDeps): Promise<() => void> {
  const warn = deps.warn ?? ((line: string) => console.warn(line))
  const now = deps.now ?? Date.now
  const known = new Map<string, Known>()
  let stopped = false

  const push = async (bot: string, platform: string, state: Known) => {
    const list = chatMenu(deps.language())
    const key = JSON.stringify(list)
    if (!state.ready || state.given === key || state.inFlight === key) return
    // A refusal is not repeated at every status: the same list waits a minute, a changed one is tried at once. It is
    // given only once the app took it, so a network that was down does not leave the bot without a menu until a restart.
    if (state.failed?.key === key && now() < state.failed.retryAt) return
    state.inFlight = key
    const epoch = state.epoch
    try {
      await deps.set(bot, platform, list)
      if (state.epoch !== epoch) return
      state.given = key
      delete state.failed
    } catch (error) {
      warn(`ADE: menu dei comandi non messo (${platform}): ${error instanceof Error ? error.message : String(error)}`)
      if (state.epoch !== epoch) return
      state.failed = { key, retryAt: now() + RETRY_AFTER_MS }
    } finally {
      if (state.epoch === epoch && state.inFlight === key) delete state.inFlight
    }
  }

  const see = (link: MenuLink) => {
    if (stopped || !MENU_PLATFORMS.includes(link.platform)) return
    const id = `${link.bot}\n${link.platform}`
    const state = known.get(id) ?? { ready: false }
    known.set(id, state)
    const ready = link.running && link.connected
    // A gateway that came up is a new adapter: it has no menu yet.
    if (ready && !state.ready) {
      delete state.given
      delete state.failed
      // A list still being put went to the adapter that is gone: the new one is asked at once, not when that one answers.
      delete state.inFlight
      state.epoch = (state.epoch ?? 0) + 1
    }
    state.ready = ready
    void push(link.bot, link.platform, state)
  }

  const unlisten = await deps.onStatus(see)
  const unwatch = deps.watchLanguage(() => {
    for (const [id, state] of known) {
      const [bot, platform] = id.split("\n") as [string, string]
      void push(bot, platform, state)
    }
  })
  try {
    for (const link of await deps.statuses()) see(link)
  } catch {
    // No list: the events will say.
  }
  return () => {
    stopped = true
    unlisten()
    unwatch()
  }
}
