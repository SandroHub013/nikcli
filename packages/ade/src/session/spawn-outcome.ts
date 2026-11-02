/**
 * What `ade-msg spawn` hears about the start of the session it asked for.
 *
 * The receipt used to go out the moment the pane was made: «ok: avviata». A program that does not exist, a key the host
 * refused, a folder gone, was then said in the pane alone, with «Riprova», while the sender went on waiting on a session
 * that was never there (live test 2026-11-02). The receipt now waits for the start to settle, for a bounded time, and
 * says what happened.
 */

/** How long the receipt waits for the start: a slow one is not a failed one, and the client gives up at ten seconds. */
export const SPAWN_START_WAIT_MS = 6_000

export type SpawnOutcome = { kind: "started" } | { kind: "failed"; reason: string } | { kind: "slow" }

/**
 * Waits for `started` (the start of the pane, which settles once the host has spawned or refused), at most `capMs`,
 * then reads whether it failed. `failure` is asked after the wait, never before: a refusal is recorded while the start
 * is still on its way.
 */
export async function spawnOutcome(
  started: Promise<unknown>,
  failure: () => string | undefined,
  capMs: number = SPAWN_START_WAIT_MS,
): Promise<SpawnOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = await Promise.race([
    started.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), capMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  const reason = failure()
  if (reason !== undefined) return { kind: "failed", reason }
  return settled ? { kind: "started" } : { kind: "slow" }
}

/** The receipt for a spawn whose session did not start. The pane stays, with «Riprova», and the sender closes it. */
export function formatSpawnFailed(title: string, paneId: string, reason: string): string {
  return (
    `errore: la sessione "${title}" non è partita: ${reason}. ` +
    `Il pannello resta (id ${paneId}) con «Riprova» per chi guarda ADE; la richiesta è chiusa: chiudi il pannello con ade-msg close ${paneId}`
  )
}
