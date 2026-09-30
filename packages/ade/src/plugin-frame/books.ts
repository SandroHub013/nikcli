/** The four books ADE keeps about plugins in a frame, on top of its own storage (`grants.ts`): one set for the whole window. */

import {
  createGrantBook,
  createRejectedBook,
  createSaltBook,
  createUnconfirmedBook,
  type BookStorage,
  type GrantBook,
  type RejectedBook,
  type UnconfirmedBook,
} from "./grants"

function storage(): BookStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

export interface PluginBooks {
  grants: GrantBook
  rejected: RejectedBook
  salts: ReturnType<typeof createSaltBook>
  unconfirmed: UnconfirmedBook
}

let books: PluginBooks | undefined

export function pluginBooks(): PluginBooks {
  books ??= {
    grants: createGrantBook(storage()),
    rejected: createRejectedBook(storage()),
    salts: createSaltBook(storage()),
    unconfirmed: createUnconfirmedBook(storage()),
  }
  return books
}

/** An uninstalled plugin leaves nothing behind in ADE's own storage. */
export function forgetPlugin(id: string): void {
  const all = pluginBooks()
  all.grants.forget(id)
  all.rejected.forget(id)
  all.salts.forget(id)
  all.unconfirmed.clear(id)
}
