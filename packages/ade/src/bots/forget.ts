/**
 * What ADE keeps about a bot besides its file, taken away when the file is deleted.
 *
 * Without this a bot made again at the same path found its routines (with a consent that the file does not change),
 * its memory and its account choice waiting for it (full review 2026-10-06, bots 17). The gateways are cleared before
 * the file goes (`deleteBot`); the rest lives in the WebView's storage and is cleared here.
 */

import { ACCOUNT_PLAN, type AccountStore } from "./account"
import { EMPTY_MEMORY, type MemoryStore } from "./memory"
import { removeRoutinesOf, type RoutineBook } from "./routine"

export function forgetBotTraces(
  path: string,
  stores: {
    memory: MemoryStore
    account: AccountStore
    /** Applies a change to the routines book, as the panel does. */
    routines: (change: (book: RoutineBook) => RoutineBook) => void
  },
): void {
  stores.routines((book) => removeRoutinesOf(book, path))
  stores.memory.set(path, EMPTY_MEMORY)
  stores.account.set(path, ACCOUNT_PLAN)
}
