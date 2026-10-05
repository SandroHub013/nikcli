/*
 * A yes/no question to the user that works in ADE.
 *
 * Not `confirm()`: in ADE the dialog plugin replaces `window.confirm` with
 * its `confirm` command, which this window is not granted
 * (`capabilities/default.json` has `dialog:allow-ask`). The call returns a
 * Promise — always truthy to an `if` — that then rejects, so every question
 * asked that way was a yes nobody gave: an unsaved file closed, a changed file
 * overwritten (F-confirm, found live in B7).
 *
 * And not the plugin's `ask` on Windows either. Its dialog has «Yes» as the
 * default button and no way to choose another, so a key or a click that reached
 * the question by chance — it can sit hidden behind a minimised ADE — answered
 * «close anyway?» with a yes nobody gave. On Windows the question is `ade_ask`
 * (`src-tauri/src/ask.rs`): the same dialog with «No» as the default, and only
 * the «Yes» button answering yes. Elsewhere the default is the system's own and
 * the plugin's `ask` is what there is.
 */
import { t } from "../i18n"

export interface AskOptions {
  readonly title: string
  readonly kind: "warning"
  readonly okLabel?: string
  readonly cancelLabel?: string
}

export type AskDialog = (message: string, options: AskOptions) => Promise<boolean>

/** The question as the native Windows command takes it. */
export interface NativeAskOptions {
  readonly title: string
  readonly yes: string
  readonly no: string
}

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
  /** Whether the question can be the native one with «No» as the default: Windows. */
  readonly nativeAvailable: () => boolean
  /** The native question; true only on «Yes». */
  readonly nativeAsk: (message: string, options: NativeAskOptions) => Promise<boolean>
  /** Whether the window is reduced to an icon, where a question owned by it cannot be seen. */
  readonly isMinimized: () => Promise<boolean>
  /** Brings the window back from the icon. Not the focus: the question is the one to have it. */
  readonly restore: () => Promise<void>
  /** Gives the foreground to the question already open, so a key answers it at once. */
  readonly front: () => Promise<void>
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
  nativeAvailable: () => typeof navigator !== "undefined" && /win/i.test(navigator.userAgent ?? ""),
  nativeAsk: async (message, options) => {
    const { invoke } = await import("@tauri-apps/api/core")
    return (await invoke<boolean>("ade_ask", { message, ...options })) === true
  },
  isMinimized: async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    return getCurrentWindow().isMinimized()
  },
  restore: async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    await getCurrentWindow().unminimize()
  },
  front: async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("ade_ask_front")
  },
}

/** A window call that never returns must not keep the question from opening. */
const RESTORE_WAIT_MS = 1500

const bounded = (work: Promise<unknown>): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, RESTORE_WAIT_MS)
    void work
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        resolve()
      })
  })

/**
 * Brings ADE back from the icon, so the question that waits on it can be seen.
 *
 * The question is owned by the window, and goes with it when the window is
 * minimised. Only the window is restored here: it is disabled while the question
 * stands, so focusing it left the foreground on a window that ignores
 * every key. A question not open yet takes the foreground when it opens; one that
 * is open gets it from `front`. A key that arrives at it answers no.
 */
async function showWindow(deps: AskDeps): Promise<void> {
  const minimized = await deps.isMinimized().catch(() => false)
  if (minimized) await deps.restore().catch(() => undefined)
}

/**
 * A close asked again while its question is open: the question is brought in
 * front, not asked a second time, and the second ✕ is no longer a click on
 * something that seems to do nothing.
 */
export async function remindQuestion(deps: AskDeps = defaultDeps): Promise<void> {
  if (!deps.inTauri()) return
  await bounded(
    showWindow(deps).then(() => (deps.nativeAvailable() ? deps.front().catch(() => undefined) : undefined)),
  )
  void deps.attention(true).catch(() => undefined)
}

/**
 * True only on the user's yes; rejects when the question cannot be put, for a
 * caller that says why on screen (the Bot section's trust, `bots.ask.failed`).
 *
 * «No» is the default button on Windows, and the labels are «Sì» and «No»
 * unless the caller gives its own.
 */
export async function askDialog(
  question: string,
  labels: { readonly ok?: string; readonly cancel?: string } = {},
  deps: AskDeps = defaultDeps,
): Promise<boolean> {
  if (!deps.inTauri()) return deps.browserConfirm(question) === true
  const native = deps.nativeAvailable()
  // The plugin is loaded for the systems that have no native question, and not before it is needed.
  const plugin = native ? undefined : await deps.load()
  // A window reduced to an icon takes the question with it; it comes back first, and bounded, so a
  // window call that never returns cannot keep the question from opening.
  await bounded(showWindow(deps))
  // The dialog opens over ADE's window, and with it behind whatever the user
  // is in: a bot's trust asked from a Telegram message went unseen
  // (chat-bot-facili, prove). The window flashes in the taskbar. Not awaited: a
  // window call that never returned kept the question from opening (review of
  // chat-difetti, BASSO 1). The stop comes after the start, so a late start
  // cannot leave ADE flashing once answered.
  const eye = deps.attention(true).catch(() => undefined)
  try {
    if (native) {
      return (
        (await deps.nativeAsk(question, {
          title: "ADE",
          yes: labels.ok ?? t("ask.yes"),
          no: labels.cancel ?? t("ask.no"),
        })) === true
      )
    }
    return (
      (await plugin!.ask(question, {
        title: "ADE",
        kind: "warning",
        ...(labels.ok ? { okLabel: labels.ok } : {}),
        ...(labels.cancel ? { cancelLabel: labels.cancel } : {}),
      })) === true
    )
  } finally {
    void eye.then(() => deps.attention(false)).catch(() => undefined)
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
