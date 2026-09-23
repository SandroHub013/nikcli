/**
 * What the update dialog shows and which of its two buttons work, decided
 * outside the component so the rules are testable without a DOM.
 *
 * Four stages: the question, the download, the hand-over to the installer,
 * and a failure. While the download runs the filled button is off, since the
 * plugin cannot stop a download once started and a button that said
 * «Annulla» would lie; the ghost becomes «Nascondi», which puts the dialog
 * away and leaves the download to the bell's bar, so there is always a way
 * out and always something that holds the focus.
 */
import type { UpdateProgress } from "./progress"

export type UpdateStage = "ask" | "download" | "install" | "error"

export interface UpdateDialogView {
  readonly stage: UpdateStage
  /** The ghost button: refuse before it starts, hide while it runs, close after it failed. */
  readonly ghost: { readonly label: "later" | "hide" | "close"; readonly enabled: boolean }
  /** The filled button: go, or retry. */
  readonly submit: { readonly label: "go" | "retry"; readonly enabled: boolean }
  /** Esc and a click on the scrim do what the ghost button does; the dialog can always be put away. */
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
  return { stage, ghost: { label: "hide", enabled: true }, submit: { label: "go", enabled: false }, dismissable: true }
}

/** Where Tab (or Shift+Tab) goes next among `count` stops, wrapping at both ends; -1 means nothing had the focus. */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return backwards ? count - 1 : 0
  if (backwards) return current <= 0 ? count - 1 : current - 1
  return current >= count - 1 ? 0 : current + 1
}
