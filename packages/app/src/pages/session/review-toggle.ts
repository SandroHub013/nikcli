import { parseTab } from "./tab-identity"

/**
 * What "Toggle review" should do.
 *
 * The control shares a panel with the file, context and browser tabs, so
 * "toggle the panel" meant that asking for review while the visual editor was
 * open closed the editor instead — and left its tab active with nothing able to
 * render it.
 *
 * Reading the name literally fixes it: the control's job is to show review.
 * Closing is only what it means when review is what you are already looking at.
 *
 * The tab passed in must be the selected one, `tabs().active()` — not the derived
 * active tab. The derived one only ever reports "review" on desktop with the file
 * tree closed, so feeding it here makes the control one-way in every other
 * layout: it opens the panel and can never close it again.
 */
export type ReviewToggleAction = "open" | "close" | "activate"

export function reviewToggleAction(input: {
  panelOpen: boolean
  /** `tabs().active()` — what the user selected, before any derivation. */
  selectedTab: string | undefined
}): ReviewToggleAction {
  if (!input.panelOpen) return "open"
  if (!input.selectedTab) return "activate"
  return parseTab(input.selectedTab).kind === "review" ? "close" : "activate"
}
