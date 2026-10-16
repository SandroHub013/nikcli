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
}

interface Known {
  /** The gateway is up and reading. */
  ready: boolean
  /** The list last given (or tried) since it came up. */
  given?: string
}

/** Starts keeping the menus; resolves with the way to stop. */
export async function startMenuSync(deps: MenuDeps): Promise<() => void> {
  const warn = deps.warn ?? ((line: string) => console.warn(line))
  const known = new Map<string, Known>()
  let stopped = false

  const push = async (bot: string, platform: string, state: Known) => {
    const list = chatMenu(deps.language())
    const key = JSON.stringify(list)
    if (!state.ready || state.given === key) return
    // Tried counts as given: a refusal is not repeated at every status until the list or the gateway changes.
    state.given = key
    try {
      await deps.set(bot, platform, list)
    } catch (error) {
      warn(`ADE: menu dei comandi non messo (${platform}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const see = (link: MenuLink) => {
    if (stopped || !MENU_PLATFORMS.includes(link.platform)) return
    const id = `${link.bot}\n${link.platform}`
    const state = known.get(id) ?? { ready: false }
    known.set(id, state)
    const ready = link.running && link.connected
    // A gateway that came up is a new adapter: it has no menu yet.
    if (ready && !state.ready) delete state.given
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
