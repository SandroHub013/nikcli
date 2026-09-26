/*
 * A yes/no question to the user that works in ADE.
 *
 * Not `confirm()`: in ADE the dialog plugin replaces `window.confirm` with
 * its `confirm` command, which this window is not granted
 * (`capabilities/default.json` has `dialog:allow-ask`). The call returns a
 * Promise — always truthy to an `if` — that then rejects, so every question
 * asked that way was a yes nobody gave: an unsaved file closed, a changed file
 * overwritten (F-confirm, found live in B7).
 */

export interface AskOptions {
  readonly title: string
  readonly kind: "warning"
  readonly okLabel?: string
  readonly cancelLabel?: string
}

export type AskDialog = (message: string, options: AskOptions) => Promise<boolean>

export interface AskDeps {
  /** Whether this is the ADE window, where only the dialog plugin can ask. */
  readonly inTauri: () => boolean
  readonly load: () => Promise<{ ask: AskDialog }>
  /** The browser's own question, outside ADE (the page served by vite alone). */
  readonly browserConfirm: (message: string) => boolean
  /**
   * `true` before the question: the window asks for the user's eye when it is
   * not the one in front. `false` once answered, to stop asking.
   */
  readonly attention: (on: boolean) => Promise<void>
}

const defaultDeps: AskDeps = {
  inTauri: () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window),
  load: () => import("@tauri-apps/plugin-dialog"),
  browserConfirm: (message) => window.confirm(message),
  attention: async (on) => {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window")
    const win = getCurrentWindow()
    if (!on) return win.requestUserAttention(null)
    if (!(await win.isFocused())) await win.requestUserAttention(UserAttentionType.Critical)
  },
}

/**
 * True only on the user's yes; rejects when the question cannot be put, for a
 * caller that says why on screen (the Bot section's trust, `bots.ask.failed`).
 */
export async function askDialog(
  question: string,
  labels: { readonly ok?: string; readonly cancel?: string } = {},
  deps: AskDeps = defaultDeps,
): Promise<boolean> {
  if (!deps.inTauri()) return deps.browserConfirm(question) === true
  const { ask } = await deps.load()
  // The dialog opens over ADE's window, and with it behind whatever the user
  // is in: a bot's trust asked from a Telegram message went unseen
  // (chat-bot-facili, prove). The window flashes in the taskbar; it does not
  // take the focus, which would hand a keystroke meant elsewhere to the question.
  await deps.attention(true).catch(() => undefined)
  try {
    return (
      (await ask(question, {
        title: "ADE",
        kind: "warning",
        ...(labels.ok ? { okLabel: labels.ok } : {}),
        ...(labels.cancel ? { cancelLabel: labels.cancel } : {}),
      })) === true
    )
  } finally {
    await deps.attention(false).catch(() => undefined)
  }
}

/** True only on the user's yes. A question that cannot be put is a no. */
export async function askYesNo(
  question: string,
  labels: { readonly ok?: string; readonly cancel?: string } = {},
  deps: AskDeps = defaultDeps,
): Promise<boolean> {
  try {
    return await askDialog(question, labels, deps)
  } catch {
    return false
  }
}
