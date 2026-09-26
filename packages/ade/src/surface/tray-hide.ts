/**
 * What the page does when the X hides ADE to the tray (G11 review, M1).
 *
 * With a bot's gateway on, the X does not close ADE: the window goes to the
 * tray and everything in it keeps running, the gateway as it should, but also
 * the agent sessions at work, which spend on the user's accounts. So it is
 * said before it happens:
 *
 * - with sessions at work, every time, a question with three answers: hide
 *   and let them go on (the first, and the one Enter gives), close them and
 *   hide, or keep the window. The dialog's own X is the third: Windows gives
 *   the cancel slot to it, and it must not be the one that closes anything.
 *   Leaving ADE altogether is Esci, in the tray's menu, and the question says
 *   so;
 * - without, once ever, a note that ADE stays in the tray while a gateway is
 *   on.
 *
 * Hidden, always-on listening closes (`voice/listen-guard.ts`): no microphone
 * open in a window nobody sees.
 */

import { t } from "../i18n"

export type HidePlan =
  /** Sessions at work: the question, with its three answers. */
  | { readonly kind: "ask"; readonly working: number }
  /** The first hide ever without: the note, then hide. */
  | { readonly kind: "notice" }
  | { readonly kind: "hide" }

export function planHide(state: { readonly working: number; readonly noticed: boolean }): HidePlan {
  if (state.working > 0) return { kind: "ask", working: state.working }
  return state.noticed ? { kind: "hide" } : { kind: "notice" }
}

export type HideChoice = "hide" | "close-sessions" | "keep"

/** The question's buttons: `yes` is the first and the default, `cancel` is also the dialog's X. */
export function hideButtons(): { readonly yes: string; readonly no: string; readonly cancel: string } {
  return { yes: t("tray.hide.keepSessions"), no: t("tray.hide.closeSessions"), cancel: t("tray.hide.cancel") }
}

/**
 * The answer, from the label the dialog gives back. Anything unknown keeps
 * the window: a question that went wrong hides nothing and closes nothing.
 */
export function hideChoice(answer: unknown, buttons = hideButtons()): HideChoice {
  if (answer === buttons.yes) return "hide"
  if (answer === buttons.no) return "close-sessions"
  return "keep"
}

export const TRAY_NOTICE_KEY = "ade.tray.noticed"

/** Whether the note was already given. Storage that cannot be read counts as given: a note is not worth a question every time. */
export function trayNoticed(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(TRAY_NOTICE_KEY) === "1" || storage === undefined
  } catch {
    return true
  }
}

export function markTrayNoticed(storage: Pick<Storage, "setItem"> | undefined): void {
  try {
    storage?.setItem(TRAY_NOTICE_KEY, "1")
  } catch {
    // Given again next time: nothing lost.
  }
}
