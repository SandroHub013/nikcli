/**
 * Whether any plugin in a frame is installed, kept where ADE can read it without touching the plugins' folder: ADE with no plugin does not
 * look at that folder at all, not at start and not on the update check. The panel and the list in the settings set it when they see what is
 * there; nothing else does.
 */

export const FRAME_PLUGINS_KEY = "ade.frame-plugins"

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** Whether a plugin was last seen installed. */
export function anyFramePlugin(store: Pick<Storage, "getItem"> | undefined = storage()): boolean {
  try {
    return store?.getItem(FRAME_PLUGINS_KEY) === "1"
  } catch {
    return false
  }
}

export function markFramePlugins(present: boolean, store: Pick<Storage, "setItem" | "removeItem"> | undefined = storage()): void {
  try {
    if (present) store?.setItem(FRAME_PLUGINS_KEY, "1")
    else store?.removeItem(FRAME_PLUGINS_KEY)
  } catch {
    // A profile without storage checks for updates as if there were no plugin, which costs nothing.
  }
}
