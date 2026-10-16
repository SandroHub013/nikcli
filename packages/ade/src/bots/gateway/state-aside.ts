/**
 * The gateways' saved state, put aside because it could not be read (N-A11a).
 *
 * Rust keeps a copy (`state.corrupt-<ms>.json`) and starts clean: pairings, the gateways that were on and their
 * projects are gone. Until now nobody was told, and in a release build the one line it wrote went nowhere. Here the
 * panel says it, once, with where the copy is and never what is in it.
 *
 * Two ways in: the event, when it happens while the page listens, and a question at start, because the first read of the
 * state comes before the page listens. A copy already told is not told again, whichever way it came.
 */

import { createSignal } from "solid-js"

export interface StateAsideDeps {
  /** The copies put aside since the last time this asked, as paths; Rust empties its list. */
  readonly take: () => Promise<readonly string[]>
  /** Every copy as it is put aside; resolves with the way to stop. */
  readonly listen: (heard: (path: string) => void) => Promise<() => void>
}

export function createStateAside() {
  const [copies, setCopies] = createSignal<readonly string[]>([])
  /** Every copy told in this run, dismissed or not: said once. */
  const told = new Set<string>()
  const add = (path: string) => {
    if (typeof path !== "string" || !path || told.has(path)) return
    told.add(path)
    setCopies((now) => [...now, path])
  }
  return {
    /** The copies the panel is saying now. */
    copies,
    /** The notice is read: it goes, and does not come back for these copies. */
    dismiss: () => setCopies([]),
    add,
    /** Starts listening and asks what was put aside before; resolves with the way to stop. */
    async start(deps: StateAsideDeps): Promise<() => void> {
      const stop = await deps.listen(add)
      try {
        for (const path of await deps.take()) add(path)
      } catch {
        // No answer: the event will say, if it happens again.
      }
      return stop
    },
  }
}

export type StateAside = ReturnType<typeof createStateAside>

/** The one the app has. */
export const appStateAside: StateAside = createStateAside()
