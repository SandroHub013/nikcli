/**
 * Reads whether the keychain holds the xAI key, and claims the voice shortcuts again when that decides whether voice is set up.
 *
 * Plain `.ts` with the keychain, the page's signals and the claim injected, so the transitions are tested without a webview:
 * - a read that fails is not «no key»: it is said apart (`setUnreadable`) and tried again after a short back-off;
 * - the shortcuts are claimed again only when the gate's answer changes, not on every read;
 * - an answer that arrives after a newer read started is dropped, so an old read never overwrites a newer one.
 */

import type { KeyInfo } from "../secrets/keys"
import { xaiKeyEntry } from "../secrets/xai-key"

export interface XaiKeyWatchDeps {
  /** The keychain's entries. Rejects, or gives `undefined`, when it cannot be read. */
  list: () => Promise<readonly KeyInfo[] | undefined>
  /** The masked tail the page holds: `null` without a key, `undefined` until a read has answered. Never the value. */
  masked: () => string | null | undefined
  setMasked: (masked: string | null) => void
  /** The last read failed (`true`) or answered (`false`). */
  setUnreadable: (unreadable: boolean) => void
  /** Whether voice is set up, for the settings as they are now and an xAI key that is there or not. */
  setUpWith: (hasXaiKey: boolean) => boolean
  /** Claims the shortcuts again, from the settings as they are now. */
  claim: () => void
  /** Runs `run` after `ms`; the result cancels it. Defaults to a timer. */
  after?: (ms: number, run: () => void) => () => void
  /** The waits between the retries of a failed read. Defaults to 2 s, 6 s, 15 s. */
  delays?: readonly number[]
}

export const XAI_KEY_RETRY_DELAYS: readonly number[] = [2_000, 6_000, 15_000]

const timer = (ms: number, run: () => void): (() => void) => {
  const id = setTimeout(run, ms)
  return () => clearTimeout(id)
}

export function createXaiKeyWatch(deps: XaiKeyWatchDeps): { refresh: () => Promise<void>; stop: () => void } {
  const delays = deps.delays ?? XAI_KEY_RETRY_DELAYS
  const after = deps.after ?? timer
  let generation = 0
  let attempt = 0
  let cancelRetry: (() => void) | undefined

  const stop = () => {
    cancelRetry?.()
    cancelRetry = undefined
    // Whatever is still in flight answers into a window that is gone.
    generation++
  }

  const refresh = async (): Promise<void> => {
    const mine = ++generation
    let keys: readonly KeyInfo[] | undefined
    try {
      keys = await deps.list()
    } catch {
      keys = undefined
    }
    if (mine !== generation) return

    if (!keys) {
      deps.setUnreadable(true)
      cancelRetry?.()
      cancelRetry = undefined
      const wait = delays[attempt]
      if (wait !== undefined) {
        attempt++
        cancelRetry = after(wait, () => {
          cancelRetry = undefined
          void refresh()
        })
      }
      return
    }

    attempt = 0
    cancelRetry?.()
    cancelRetry = undefined
    deps.setUnreadable(false)
    const before = deps.setUpWith(typeof deps.masked() === "string")
    deps.setMasked(xaiKeyEntry(keys)?.masked ?? null)
    if (before !== deps.setUpWith(typeof deps.masked() === "string")) deps.claim()
  }

  return { refresh, stop }
}
