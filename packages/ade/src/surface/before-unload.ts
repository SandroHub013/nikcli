import { isPanelPane, type Pane } from "./state"

/**
 * Whether leaving the page has to be confirmed.
 *
 * A modified buffer lives only in memory, so leaving with one open loses it.
 * And since a reload ends every pty the old page started (`pty-ricarica`,
 * `lib.rs` `on_page_load`), leaving with an agent at work kills it mid-turn,
 * with its whole process tree: an F5 pressed by mistake with the focus on the
 * sidebar did that without a word (audit 0.7.7, MEDIO 16). Both ask first.
 */
export function mustConfirmLeaving(state: { unsavedBuffers: number; runningSessions: number }): boolean {
  return state.unsavedBuffers > 0 || state.runningSessions > 0
}

export type WorkingAgentPaneCandidate = Pick<Pane, "id"> &
  Partial<Pick<Pane, "status" | "agent" | "model" | "mode" | "browserUrl" | "filePath" | "videoPath" | "modelPath" | "appUrl" | "plugin">>

/**
 * Whether a pane is an active agent session currently at work (D81, option B).
 *
 * Excludes:
 * - processes that have died or exited (!running.has)
 * - tool/panel panes (video, browser, app, etc. - via isPanelPane)
 * - terminal panes (cmd, pwsh, bash)
 * - idle sessions sitting at the prompt, done, or errored
 *
 * Includes:
 * - agent sessions alive with status "working" or "waiting" (e.g. permission prompt mid-turn)
 */
export function isWorkingAgentPane(
  pane: WorkingAgentPaneCandidate,
  running: { has(id: string): boolean },
): boolean {
  if (!running.has(pane.id)) return false
  if (isPanelPane({ ...pane, mode: pane.mode ?? "" })) return false
  const agentId = pane.agent ?? pane.model
  if (!agentId || agentId === "terminal") return false
  return pane.status === "working" || pane.status === "waiting"
}

/**
 * Counts how many agent sessions are alive and actively working (D81).
 *
 * Separated from `mustConfirmLeaving`: closing the window only asks confirmation
 * if at least one agent session is actually working mid-turn (status "working" or
 * "waiting" on permission). If only terminal shells or idle sessions at the prompt
 * are open, the window closes immediately without prompt.
 */
export function countWorkingSessions(
  panes: readonly WorkingAgentPaneCandidate[],
  running: { has(id: string): boolean },
): number {
  return panes.filter((pane) => isWorkingAgentPane(pane, running)).length
}

/**
 * Whether closing the window requires user confirmation (D81).
 *
 * Distinct from `mustConfirmLeaving`: asks only if there are agent sessions at work.
 */
export function shouldConfirmWindowClose(state: { working?: number; workingSessions?: number }): boolean {
  const count = state.working ?? state.workingSessions ?? 0
  return count > 0
}

/**
 * Message shown when window close is requested with active sessions.
 */
export function closeConfirmationMessage(workingSessions: number): string {
  if (workingSessions === 1) {
    return "1 sessione sta lavorando. Chiudere lo stesso?"
  }
  return `${workingSessions} sessioni stanno lavorando. Chiudere lo stesso?`
}
