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
