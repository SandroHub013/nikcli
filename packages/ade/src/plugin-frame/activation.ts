/**
 * What happens when a plugin's panel opens: which version is switched on, and what is done when it does not start.
 *
 * The native side serves only `current` (`plugin_scheme.rs`), so a version that was downloaded in the background and is `pending` cannot
 * answer `ready` until it is committed. So, in this order:
 *
 * 1. a pending version whose permissions were all accepted is committed (`plugin_commit`), then the frame is loaded;
 * 2. one that asks for a permission more waits for the user's answer, in ADE's own DOM, and is not committed without it;
 * 3. a version that was just committed has `READY_MS` to say `ready`; if it does not, `plugin_rollback` and a notice, and that version is
 *    remembered and not offered again. With no earlier version there is nothing to go back to: the error is shown, with «Disinstalla».
 *
 * Kept apart from the panel, with the clock and the native commands given, so all of it can be driven from a test.
 */

import { addedPermissions, type RejectedBook } from "./grants"
import type { Permission } from "./api"
import type { InstalledPlugin } from "./host-types"

export type { InstalledPlugin }

/** How long a version that was just switched on has to say `ready`. */
export const READY_MS = 15_000

export type Phase =
  | { kind: "checking" }
  /** Nothing is installed under this id: the panel shows «X non è installato · Installa». */
  | { kind: "absent" }
  /** A new version asks for more than was accepted. `current` says whether the version in use can carry on meanwhile. */
  | { kind: "consent"; version: string; added: Permission[]; current?: string }
  /** `permissions`: what the manifest of the version being loaded asks for. */
  | { kind: "loading"; version: string; committed: boolean; dev: boolean; permissions: string[] }
  | { kind: "ready"; version: string }
  /** The new version did not start; the earlier one is back, and the frame must load again. */
  | { kind: "rolled-back"; from: string; to: string }
  /** It did not start, and there is nothing to go back to. */
  | { kind: "failed"; version: string; reason: string }

export interface ActivationIo {
  /** The plugin as installed, or nothing. */
  list: () => Promise<InstalledPlugin | undefined>
  commit: () => Promise<string>
  rollback: () => Promise<string>
  /** What the user accepted for this plugin. */
  accepted: () => Permission[]
  /** The user said yes to these. */
  accept: (permissions: Permission[]) => void
  rejected: Pick<RejectedBook, "add">
  schedule: (run: () => void, ms: number) => () => void
  phase: (phase: Phase) => void
}

export function createActivation(id: string, io: ActivationIo) {
  let current: Phase = { kind: "checking" }
  let cancel: (() => void) | undefined
  let waiting: InstalledPlugin | undefined
  let disposed = false

  const set = (phase: Phase) => {
    if (disposed) return
    current = phase
    io.phase(phase)
  }
  const stopClock = () => {
    cancel?.()
    cancel = undefined
  }

  /** Loads `version`; one that was just committed is given `READY_MS` to answer. */
  const load = (version: string, committed: boolean, dev: boolean, hadEarlier: boolean, permissions: string[]) => {
    set({ kind: "loading", version, committed, dev, permissions })
    if (!committed) return
    cancel = io.schedule(async () => {
      cancel = undefined
      if (current.kind !== "loading" || current.version !== version) return
      if (!hadEarlier) return set({ kind: "failed", version, reason: "la versione non ha risposto" })
      try {
        const back = await io.rollback()
        io.rejected.add(id, version)
        set({ kind: "rolled-back", from: version, to: back })
      } catch (error) {
        set({ kind: "failed", version, reason: error instanceof Error ? error.message : String(error) })
      }
    }, READY_MS)
  }

  const commitAndLoad = async (entry: InstalledPlugin) => {
    try {
      const version = await io.commit()
      load(version, true, false, Boolean(entry.current), entry.pending_permissions ?? [])
    } catch (error) {
      // The version in use carries on; the new one stays pending and is tried again at the next opening.
      if (entry.current) return load(entry.current, false, false, false, entry.permissions)
      set({ kind: "failed", version: entry.pending ?? "?", reason: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    phase: () => current,

    /** The panel opens (or opens again). */
    async open() {
      stopClock()
      waiting = undefined
      set({ kind: "checking" })
      let entry: InstalledPlugin | undefined
      try {
        entry = await io.list()
      } catch {
        return set({ kind: "absent" })
      }
      if (!entry || (!entry.current && !entry.pending)) return set({ kind: "absent" })
      if (entry.dev && entry.current) return load(entry.current, false, true, false, entry.permissions)
      if (entry.pending) {
        const added = addedPermissions(entry.pending_permissions ?? [], io.accepted())
        if (added.length > 0) {
          waiting = entry
          return set({ kind: "consent", version: entry.pending, added, ...(entry.current ? { current: entry.current } : {}) })
        }
        return commitAndLoad(entry)
      }
      load(entry.current!, false, false, false, entry.permissions)
    },

    /** The user answered the question about the permissions a new version adds. */
    async answer(yes: boolean) {
      const entry = waiting
      if (!entry || current.kind !== "consent") return
      waiting = undefined
      if (yes) {
        io.accept(current.added)
        return commitAndLoad(entry)
      }
      // No: the new version stays pending and asks again at the next opening; the one in use carries on.
      if (entry.current) return load(entry.current, false, false, false, entry.permissions)
      set({ kind: "absent" })
    },

    /** The plugin said `ready`. */
    ready() {
      if (current.kind !== "loading") return
      stopClock()
      set({ kind: "ready", version: current.version })
    },

    dispose() {
      disposed = true
      stopClock()
    },
  }
}
