/**
 * When always-on listening pauses and comes back by itself.
 *
 * Listening pauses on a PC nobody can be talking to — locked, or asleep —
 * and comes back on its own at the unlock. Nothing announces a lock to the
 * page, so it asks every few seconds; a sleep shows up as a tick that arrives
 * far later than it should, and after one the microphone stream may be dead,
 * so it is opened again.
 *
 * What it does not bring back is listening that stopped itself to stop
 * spending — the cap on requests an hour, or half an hour with nobody calling
 * it. That is `isHalted`, and only the user lifts it; without it the two
 * brakes were a five-second pause in the same bill.
 */

export const LOCK_POLL_MS = 5_000
/** A gap between ticks this much longer than the poll means the PC was asleep. */
export const SLEEP_GAP_MS = 30_000

export interface ListenGuardDeps {
  now(): number
  /** Whether the session is locked; a check that fails counts as locked. */
  isLocked(): Promise<boolean>
  /** Whether ADE should be listening by itself, from the settings. */
  shouldListen(): boolean
  /** Whether any microphone is open, dictation included. */
  isListening(): boolean
  isPaused(): boolean
  /** Whether listening stopped itself and must stay stopped: see the top of this file. */
  isHalted(): boolean
  pause(): Promise<void>
  resume(): Promise<void>
  restart(): Promise<void>
}

export function createListenGuard(deps: ListenGuardDeps) {
  let last = deps.now()
  return {
    async tick(): Promise<void> {
      const at = deps.now()
      const slept = at - last > SLEEP_GAP_MS
      last = at
      /* Nobody can be talking to a locked PC: whatever is open closes, the
         dictation too, whether or not it listens by itself. A check that
         cannot answer is taken as a lock — an open microphone is the costly
         mistake. */
      const locked = await deps.isLocked().catch(() => true)
      if (locked) {
        if (deps.isListening()) await deps.pause()
        return
      }
      if (!deps.shouldListen() || deps.isHalted()) return
      if (slept && deps.isListening()) {
        await deps.restart()
        return
      }
      if (deps.isPaused()) await deps.resume()
    },
  }
}
