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
}

const defaultDeps: AskDeps = {
  inTauri: () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window),
  load: () => import("@tauri-apps/plugin-dialog"),
  browserConfirm: (message) => window.confirm(message),
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
  return (
    (await ask(question, {
      title: "ADE",
      kind: "warning",
      ...(labels.ok ? { okLabel: labels.ok } : {}),
      ...(labels.cancel ? { cancelLabel: labels.cancel } : {}),
    })) === true
  )
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
