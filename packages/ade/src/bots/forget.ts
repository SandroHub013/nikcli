/**
 * What ADE keeps about a bot besides its file, taken away when the file is deleted.
 *
 * Without this a bot made again at the same path found its routines (with a consent that the file does not change),
 * its memory and its account choice waiting for it (full review 2026-10-06, bots 17). The gateways are cleared before
 * the file goes (`deleteBot`); the rest lives in the WebView's storage and is cleared here.
 */

import { ACCOUNT_PLAN, type AccountStore } from "./account"
import type { AlwaysStore } from "./approval"
import { EMPTY_MEMORY, type MemoryStore } from "./memory"
import { REMOTE_OFF, remoteKey, type RemoteStore } from "./gateway/remote"
import { removeRoutinesOf, type RoutineBook } from "./routine"
import { TALK_KEY_PREFIX } from "./talk"

/** What `localStorage` offers to find and take away the keys of a bot. */
export type KeyedStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">

/** Where a gateway keeps its chats' CLI sessions: one object, a key per `bot:platform:chat`. */
const GATEWAY_SESSIONS_KEY = "ade.gateway.sessions"
/** And their threads: a key of their own per chat, `ade.gateway.talk`, a line break and the session key (`threads.ts`). */
const GATEWAY_TALK_PREFIX = "ade.gateway.talk\n"

/** The platforms a gateway runs on: the remote-commands switch is kept per bot AND platform (`remoteKey`). */
const GATEWAY_PLATFORMS = ["telegram", "discord", "slack"] as const

export function forgetBotTraces(
  path: string,
  stores: {
    memory: MemoryStore
    account: AccountStore
    /** The gateway's «commands from remote» switch: a bot made again with the same file would find it still on (review of F7d). */
    remote: RemoteStore
    /** Applies a change to the routines book, as the panel does. */
    routines: (change: (book: RoutineBook) => RoutineBook) => void
    /** The «Sempre» given to its dangerous commands: kept by path, so a bot made again would inherit them (S5, S9). */
    always?: AlwaysStore
    /** The renderer's storage, for the sessions and threads kept under the bot's path (S9). */
    storage?: KeyedStorage
  },
): void {
  stores.routines((book) => removeRoutinesOf(book, path))
  stores.memory.set(path, EMPTY_MEMORY)
  stores.account.set(path, ACCOUNT_PLAN)
  for (const platform of GATEWAY_PLATFORMS) stores.remote.set(remoteKey(path, platform), REMOTE_OFF)
  stores.always?.clear(path)
  if (stores.storage) forgetStoredKeys(path, stores.storage)
}

/**
 * The conversations kept under a bot's path, by prefix (review of the bots, S9): its chats' CLI sessions (one object,
 * a key per `bot:platform:chat`), their threads (`ade.gateway.talk`, a key each), and the thread of the panel
 * (`ade.bots.talk:<project>`, a line break and `<path>`, or the older form with no project). A bot made again at the same path would
 * otherwise continue them. The transcripts the CLIs keep on disk are theirs, and stay.
 */
export function forgetStoredKeys(path: string, storage: KeyedStorage): void {
  try {
    const sessions = JSON.parse(storage.getItem(GATEWAY_SESSIONS_KEY) ?? "{}") as unknown
    if (sessions && typeof sessions === "object" && !Array.isArray(sessions)) {
      const kept = Object.fromEntries(Object.entries(sessions).filter(([key]) => !key.startsWith(`${path}:`)))
      if (Object.keys(kept).length !== Object.keys(sessions).length) storage.setItem(GATEWAY_SESSIONS_KEY, JSON.stringify(kept))
    }
  } catch {
    // Unreadable or blocked: nothing to take away that could be found.
  }
  try {
    const gone: string[] = []
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key) continue
      const chatThread = key.startsWith(`${GATEWAY_TALK_PREFIX}${path}:`)
      const panelThread = key.startsWith(TALK_KEY_PREFIX) && (key.endsWith(`\n${path}`) || key === `${TALK_KEY_PREFIX}${path}`)
      if (chatThread || panelThread) gone.push(key)
    }
    for (const key of gone) storage.removeItem(key)
  } catch {
    // As above.
  }
}
