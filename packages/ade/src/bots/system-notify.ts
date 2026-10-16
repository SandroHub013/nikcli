/**
 * What ADE does outside its own window when a bot waits for the user: it makes the window flash in the taskbar
 * (`requestUserAttention`, as `host/ask.ts` does for a native question). A toast of the system, with the bot and the
 * command, needs a notification plugin that ADE does not have yet; until then the flash tells the user to look, and
 * the badge, the bell and the roster tell them what.
 */
export type Attention = () => Promise<boolean>

const inTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)

/** Flashes the window unless it already has the focus. False when it did not (the browser, or the window in front). */
const tauriAttention: Attention = async () => {
  if (!inTauri()) return false
  const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window")
  const win = getCurrentWindow()
  if (await win.isFocused()) return false
  await win.requestUserAttention(UserAttentionType.Critical)
  return true
}

export async function notifySystem(attend: Attention = tauriAttention): Promise<boolean> {
  try {
    return await attend()
  } catch {
    // A window that cannot be asked to flash is no reason to lose the request: it is still listed.
    return false
  }
}

/** Whether ADE's window is the one in front. In a place with no document, it counts as in front: nothing to add. */
export function windowInFront(
  doc: Pick<Document, "hasFocus" | "visibilityState"> | undefined = typeof document === "undefined" ? undefined : document,
): boolean {
  if (!doc) return true
  try {
    return doc.visibilityState !== "hidden" && doc.hasFocus()
  } catch {
    return true
  }
}
