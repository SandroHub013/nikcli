import { scrubSecrets } from "./terms"

/**
 * What ADE does outside its own window when a bot waits for the user and the window is behind: a system notification
 * (the Windows toast) saying whose bot and what it wants, and the taskbar icon flashing (`requestUserAttention`, as
 * `host/ask.ts` does for a native question).
 *
 * The toast goes through our own command `system_notify` (`src-tauri/src/notify.rs`), not the plugin's `notify`: the
 * window then needs no notification permission, and Rust makes the text safe to show. The flash does not depend on the
 * toast: if the toast cannot be shown (a refusal of the system, the command missing in an older build), the icon still
 * flashes. A click on the toast does nothing on Windows (the plugin has no click event there); the flash and the bell's
 * «Apri» take the user to the request.
 *
 * One toast per request, never again for the same one while it stays open: the id is the request's (`WaitingApproval.id`).
 */
export interface SystemNotice {
  /** The request's id: what makes two calls the same request. */
  readonly id: string
  readonly title: string
  readonly body: string
}

/** The two things the window can be asked; `tauriSystem` is the real one, a test passes its own. */
export interface SystemHost {
  /** The window has the focus. False outside the app: there is no window to be behind. */
  focused: () => Promise<boolean>
  flash: () => Promise<void>
  /** Shows the toast; rejects when it cannot. */
  toast: (title: string, body: string) => Promise<void>
}

export interface SystemOutcome {
  toast: boolean
  flash: boolean
}

const NOTHING: SystemOutcome = { toast: false, flash: false }

const inTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)

const tauriSystem: SystemHost = {
  focused: async () => {
    if (!inTauri()) return true
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    return await getCurrentWindow().isFocused()
  },
  flash: async () => {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window")
    await getCurrentWindow().requestUserAttention(UserAttentionType.Critical)
  },
  toast: async (title, body) => {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("system_notify", { title, body })
  },
}

/** The requests already announced. Pruned by `forgetSystemNotice` when the request closes, so a new ask is news again. */
const announced = new Set<string>()

/** The request is no longer open: if it is asked again, it is announced again. */
export function forgetSystemNotice(open: ReadonlySet<string>): void {
  for (const id of announced) if (!open.has(id)) announced.delete(id)
}

/** The tests start from an empty list. */
export function resetSystemNotices(): void {
  announced.clear()
}

/**
 * Announces a request outside the window, once: when the window lacks the focus, the toast and the flash; when it has
 * it, nothing (and the request is not marked, so a later call finds it new).
 * Never throws: the request is also in the bell, the badge and the roster.
 */
export async function notifySystem(notice: SystemNotice, host: SystemHost = tauriSystem): Promise<SystemOutcome> {
  if (announced.has(notice.id)) return NOTHING
  // Marked before the awaits: two calls for the same request at once must not make two toasts.
  announced.add(notice.id)
  try {
    if (await host.focused()) {
      announced.delete(notice.id)
      return NOTHING
    }
  } catch {
    announced.delete(notice.id)
    return NOTHING
  }
  const outcome = { toast: false, flash: false }
  // The text may come from a phone's question or a command line: no secret goes out of the window in a toast.
  try {
    await host.toast(scrubSecrets(notice.title), scrubSecrets(notice.body))
    outcome.toast = true
  } catch {
    // The flash below is what is left.
  }
  try {
    await host.flash()
    outcome.flash = true
  } catch {
    // A window that cannot be asked to flash is no reason to lose the request: it is still listed.
  }
  return outcome
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
