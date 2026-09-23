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

/**
 * Whether closing the window requires user confirmation (D81).
 *
 * Reuses `mustConfirmLeaving` to determine if sessions are running,
 * avoiding a duplicate definition of what counts as working.
 */
export function shouldConfirmWindowClose(state: { runningSessions: number }): boolean {
  return mustConfirmLeaving({ unsavedBuffers: 0, runningSessions: state.runningSessions })
}

/**
 * Message shown when window close is requested with active sessions.
 */
export function closeConfirmationMessage(runningSessions: number): string {
  if (runningSessions === 1) {
    return "1 sessione sta lavorando. Chiudere lo stesso?"
  }
  return `${runningSessions} sessioni stanno lavorando. Chiudere lo stesso?`
}

