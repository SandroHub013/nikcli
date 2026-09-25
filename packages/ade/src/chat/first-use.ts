/**
 * The chat's first use of a folder (C4, for C9): the trust question, the
 * server, the stream and the catalog start when the person uses the chat —
 * opens a picker, sends, or asks for it — never because the section opened.
 * Opening the section only draws what the store already has.
 */

import type { ChatCatalog } from "./connection"
import { folderKey } from "./sessions"
import type { ChatStore } from "./store"

export type FirstUseStore = Pick<ChatStore, "state" | "open" | "catalog">

/** The folder is open in the store, and not refused: its data can be shown and its catalog read. */
export function isOpenOn(store: Pick<ChatStore, "state">, root: string | undefined): boolean {
  const { directory, status } = store.state
  if (!root || directory === undefined || folderKey(directory) !== folderKey(root)) return false
  return status !== "idle" && status !== "refused"
}

/**
 * Opens `root` if it is not open yet, then hands over its catalog; true when
 * the folder is open. Opening the folder already open changes nothing, and the
 * catalog is loaded once per opening (`store.ts`), so calling this on every
 * use costs nothing after the first.
 */
export async function useFolder(
  store: FirstUseStore,
  root: string | undefined,
  onCatalog: (catalog: ChatCatalog) => void,
): Promise<boolean> {
  if (!root) return false
  if (!isOpenOn(store, root)) await store.open(root)
  if (!isOpenOn(store, root)) return false
  try {
    onCatalog(await store.catalog())
  } catch {
    // The providers did not come: the pickers stay as they are, and the next use tries again.
  }
  return true
}
