/**
 * What the update dialog shows and which of its two buttons work, decided
 * outside the component so the rules are testable without a DOM.
 *
 * Four stages: the question, the download, the hand-over to the installer,
 * and a failure. While the download runs nothing moves: the plugin cannot
 * stop a download once started, so a button that said «Annulla» would lie.
 */
import type { UpdateProgress } from "./progress"

export type UpdateStage = "ask" | "download" | "install" | "error"

export interface UpdateDialogView {
  readonly stage: UpdateStage
  /** The ghost button: refuse, or close. */
  readonly ghost: { readonly label: "later" | "close"; readonly enabled: boolean }
  /** The filled button: go, or retry. */
  readonly submit: { readonly label: "go" | "retry"; readonly enabled: boolean }
  /** Esc and a click on the scrim close the dialog only when nothing is running. */
  readonly dismissable: boolean
}

export function updateDialogView(input: {
  readonly updating: boolean
  readonly progress: UpdateProgress | undefined
  readonly error: string | undefined
}): UpdateDialogView {
  if (input.error) {
    return { stage: "error", ghost: { label: "close", enabled: true }, submit: { label: "retry", enabled: true }, dismissable: true }
  }
  if (!input.updating) {
    return { stage: "ask", ghost: { label: "later", enabled: true }, submit: { label: "go", enabled: true }, dismissable: true }
  }
  const stage: UpdateStage = input.progress?.phase === "install" ? "install" : "download"
  return { stage, ghost: { label: "later", enabled: false }, submit: { label: "go", enabled: false }, dismissable: false }
}

/** Where Tab (or Shift+Tab) goes next among `count` stops, wrapping at both ends; -1 means nothing had the focus. */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return backwards ? count - 1 : 0
  if (backwards) return current <= 0 ? count - 1 : current - 1
  return current >= count - 1 ? 0 : current + 1
}
