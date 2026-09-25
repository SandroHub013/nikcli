/**
 * What the chat's direct OpenRouter path left on disk (C8).
 *
 * Before the store, the chat kept its one conversation in `localStorage`
 * under `ade.chat`: the questions and the answers, in clear, readable by any
 * script in the webview. Nothing reads it any more; it is removed the first
 * time the Chat starts. `ade.chat.model` and `ade.chat.agent` are the pickers'
 * and stay.
 */

export const LEGACY_CONVERSATION_KEY = "ade.chat"

/** Removes the old conversation; storage that is missing or refuses is left alone. */
export function forgetLegacyConversation(storage: Pick<Storage, "removeItem"> | undefined = globalStorage()): void {
  try {
    storage?.removeItem(LEGACY_CONVERSATION_KEY)
  } catch {
    // A private window or blocked storage: there is nothing of ours there to remove.
  }
}

function globalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}
