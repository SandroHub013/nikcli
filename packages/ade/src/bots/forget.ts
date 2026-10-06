/**
 * What ADE keeps about a bot besides its file, taken away when the file is deleted.
 *
 * Without this a bot made again at the same path found its routines (with a consent that the file does not change),
 * its memory and its account choice waiting for it (full review 2026-10-06, bots 17). The gateways are cleared before
 * the file goes (`deleteBot`); the rest lives in the WebView's storage and is cleared here.
 */

import { ACCOUNT_PLAN, type AccountStore } from "./account"
import { EMPTY_MEMORY, type MemoryStore } from "./memory"
import { REMOTE_OFF, remoteKey, type RemoteStore } from "./gateway/remote"
import { removeRoutinesOf, type RoutineBook } from "./routine"

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
  },
): void {
  stores.routines((book) => removeRoutinesOf(book, path))
  stores.memory.set(path, EMPTY_MEMORY)
  stores.account.set(path, ACCOUNT_PLAN)
  for (const platform of GATEWAY_PLATFORMS) stores.remote.set(remoteKey(path, platform), REMOTE_OFF)
}
