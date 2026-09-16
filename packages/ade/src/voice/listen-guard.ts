/**
 * When always-on listening pauses and comes back by itself.
 *
 * The user's rule: it listens all the time and is switched off only by its
 * switch. The one exception is a PC nobody can be talking to — locked, or
 * asleep — where it pauses, and it comes back on its own at the unlock.
 * Nothing announces a lock to the page, so it asks every few seconds; a sleep
 * shows up as a tick that arrives far later than it should, and after one the
 * microphone stream may be dead, so it is opened again.
 */

export const LOCK_POLL_MS = 5_000
/** A gap between ticks this much longer than the poll means the PC was asleep. */
export const SLEEP_GAP_MS = 30_000

export interface ListenGuardDeps {
  now(): number
  /** Whether the session is locked; false where it cannot be known. */
  isLocked(): Promise<boolean>
  /** Whether ADE should be listening by itself, from the settings. */
  shouldListen(): boolean
  isListening(): boolean
  isPaused(): boolean
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
      if (!deps.shouldListen()) return
      const locked = await deps.isLocked().catch(() => false)
      if (locked) {
        if (deps.isListening()) await deps.pause()
        return
      }
      if (slept && deps.isListening()) {
        await deps.restart()
        return
      }
      if (deps.isPaused()) await deps.resume()
    },
  }
}
