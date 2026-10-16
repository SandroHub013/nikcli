/**
 * A notification of the system, from the page. ADE has no notification plugin (nothing in `src-tauri` sends one), so this
 * is the browser's own `Notification`, used only when the webview has already been allowed to: it never asks, because
 * the permission dialog of the webview blocks the page until it is answered. Without the permission it does nothing and
 * says so (`false`); the badge and the bell still tell the user.
 */
export function notifySystem(
  title: string,
  body: string,
  tag: string,
  api: { Notification?: typeof Notification } | undefined = typeof globalThis === "undefined" ? undefined : globalThis,
): boolean {
  try {
    const Native = api?.Notification
    if (!Native || Native.permission !== "granted") return false
    // `tag`: the same request twice is one notification.
    new Native(title, { body, tag })
    return true
  } catch {
    return false
  }
}

/** Whether ADE's window is the one in front. In a place with no document, it counts as in front: nothing to add. */
export function windowInFront(doc: Pick<Document, "hasFocus" | "visibilityState"> | undefined = typeof document === "undefined" ? undefined : document): boolean {
  if (!doc) return true
  try {
    return doc.visibilityState !== "hidden" && doc.hasFocus()
  } catch {
    return true
  }
}
