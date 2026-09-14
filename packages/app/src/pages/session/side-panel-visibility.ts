import { parseTab } from "./tab-identity"

/**
 * When the side panel may skip its tab strip and render the diff on its own.
 *
 * The shortcut exists because the file tree, while it is listing the changes,
 * already shows what the strip would repeat. It is also the only way the review
 * pane stays reachable in that layout: the strip's review trigger is gated on
 * the file tree being closed.
 *
 * The rule reads the tab the user actually selected, not the derived active tab.
 * The derived one is itself gated on the file tree being closed, so asking it
 * whether review is active while the file tree is open can only ever answer no —
 * a contradiction that silently disabled this branch and, with it, the last route
 * to the diff in that layout.
 */
export function shouldRenderBareReview(input: {
  fileTreeOpen: boolean
  fileTreeTab: "changes" | "all"
  /** `tabs().active()` — what the user selected, before any derivation. */
  selectedTab: string | undefined
}): boolean {
  if (!input.fileTreeOpen || input.fileTreeTab !== "changes") return false
  // Nothing selected yet: the diff is the only thing this half could show.
  if (!input.selectedTab) return true

  // A file, the context pane or the browser can only be reached through the
  // strip, so dropping it would strand the user on a pane they cannot leave.
  const kind = parseTab(input.selectedTab).kind
  return kind === "review" || kind === "empty"
}
