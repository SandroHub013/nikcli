import { isPseudoTab } from "./tab-identity"

/**
 * Keeps the active tab and the open-tab list from drifting apart.
 *
 * `<Tabs value={...}>` renders nothing when the value has no matching trigger
 * and no matching content: the strip highlights nothing and the pane is blank,
 * with no way for the user to get back. That happened in two ways — an active
 * file tab that was never in the list, and a list rewrite that stranded the
 * active one — so both are settled here rather than at the call sites.
 */

/** The active tab after a list rewrite: kept if still valid, else the first tab. */
export function reconcileActiveTab(input: { active: string | undefined; all: string[] }): string | undefined {
  const { active, all } = input
  if (!active) return all[0]
  if (isPseudoTab(active)) return active
  if (all.includes(active)) return active
  return all[0]
}

/** Whether a candidate file tab may be shown as active. */
export function canActivateFileTab(input: { candidate: string; all: string[] }): boolean {
  return input.all.includes(input.candidate)
}
