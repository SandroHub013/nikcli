import { createSignal, onCleanup } from "solid-js"
import type { Shot } from "./tray"

/**
 * Where the tray's screenshots come from.
 *
 * The host watches the folder the operating system saves screenshots to and
 * announces each one as it lands. This wraps that in the shape the tray wants:
 * a newest-first list, a way to take one out of it, and nothing else.
 *
 * Kept apart from the tray so the tray can be rendered — and read — without a
 * desktop host, and so this can be swapped for another source later without the
 * component learning about it.
 */

/** How many to keep on screen. Older ones are still on disk, just not in the way. */
const KEEP = 12

/** What the host says about the folder it will watch. */
export interface ShotLocation {
  dir: string
  /** A share: named in the tray, never opened. */
  network: boolean
}

export type ShotState = "asking" | "watching" | "none" | "network"

/** Why the host refused a folder the user picked: the code, never a sentence. */
export type ShotNotice = "not-a-folder" | "too-broad" | "system" | "not-saved"

const NOTICES: readonly string[] = ["not-a-folder", "too-broad", "system", "not-saved"]

export interface ShotSource {
  shots: () => Shot[]
  dismiss: (path: string) => void
  remove: (path: string) => Promise<void>
  load: (path: string) => Promise<Uint8Array | null>
  /** Where the host is watching, once it has answered. Undefined in the browser. */
  folder: () => string | undefined
  /**
   * Whether this machine has a screenshots folder at all, and whether it is on
   * a network share.
   *
   * `"asking"` until the host answers, `"none"` when it says there is no such
   * folder, `"network"` when the folder it named cannot be read without
   * sending the user's credentials to a server. The tray needs the
   * difference: with no folder no screenshot can ever arrive, and a strip
   * that stays blank forever says nothing about why.
   */
  state: () => ShotState
  /**
   * Asks the user for a folder, remembers the answer and watches it.
   *
   * A no-op in the browser, and when the dialog is dismissed.
   */
  choose: () => Promise<void>
  /** Why the last folder picked was not taken, until the next pick. */
  notice: () => ShotNotice | undefined
  /** The picker is open: asking again would open a second one. */
  choosing: () => boolean
  /** Whether there is a host to pick a folder for; false in the browser. */
  canChoose: boolean
}

/** Whether `path` is inside `dir`, whatever separator the platform used. */
function belongs(path: string, dir: string | undefined): boolean {
  if (!dir) return false
  const normalized = dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  const candidate = path.replace(/\\/g, "/").toLowerCase()
  return candidate === normalized || candidate.startsWith(`${normalized}/`)
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(command, args)
}

export function createShotSource(inTauri: boolean): ShotSource {
  const [shots, setShots] = createSignal<Shot[]>([])
  const [folder, setFolder] = createSignal<string>()
  const [state, setState] = createSignal<ShotState>(inTauri ? "asking" : "none")
  const [notice, setNotice] = createSignal<ShotNotice>()
  const [choosing, setChoosing] = createSignal(false)
  /*
   * Dismissed paths are remembered, because the folder watcher has no idea a
   * screenshot was put away: the file is still there, and the next `shots_recent`
   * — after a reload, or a second window — would bring it straight back.
   */
  const dismissed = new Set<string>()

  const add = (incoming: Shot[]) => {
    setShots((current) => {
      const byPath = new Map(current.map((shot) => [shot.path, shot]))
      for (const shot of incoming) {
        if (dismissed.has(shot.path)) continue
        byPath.set(shot.path, shot)
      }
      return [...byPath.values()].sort((a, b) => b.modified_ms - a.modified_ms).slice(0, KEEP)
    })
  }

  let disposed = false
  let stop: (() => void) | undefined
  /*
   * Which folder the page last asked for. A `shots_recent` for the previous
   * one can still be in flight when the user picks another: its answer must
   * not land in a tray that has already moved on.
   */
  let watching = 0

  /*
   * Move the tray to `location`: its folder, what it holds, and what to say
   * when it holds nothing. The old watcher is retired by `shots_watch` on the
   * host when the folder differs; the listener stays, because `shot:new` is
   * not per folder.
   */
  const watch = async (location: ShotLocation) => {
    const mine = ++watching
    setFolder(location.dir)
    setState(location.network ? "network" : "watching")
    if (!location.network) {
      // What is already there first: the screenshot taken a moment before
      // switching to ADE is the one the user came here to use, and it arrived
      // before anything was listening.
      const recent = await call<Shot[]>("shots_recent", { dir: location.dir, limit: KEEP }).catch(() => [])
      if (disposed || mine !== watching) return
      add(recent)
    }
    if (disposed || mine !== watching) return
    // Called for a share too: the host refuses it, and retires the watcher of
    // the folder the tray was on before.
    await call("shots_watch", { dir: location.dir }).catch(() => undefined)
  }

  if (inTauri) {
    /*
     * The unlisten handle is held in a variable, and the cleanup that uses
     * it is registered *synchronously*.
     *
     * Solid's owner is only current during the synchronous part of a
     * reactive scope; after an await it is null, and `onCleanup` there is a
     * silent no-op — it neither runs nor warns. So `stop` was never called:
     * the `shot:new` listener outlived the surface that installed it, and a
     * second surface added a second listener on top of the first.
     *
     * `disposed` covers the race where cleanup happens while the dynamic
     * imports are still in flight, in which case the listener must be
     * detached the moment it exists.
     */
    onCleanup(() => {
      disposed = true
      stop?.()
      stop = undefined
    })

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event")
      if (disposed) return

      const unlisten = await listen<Shot>("shot:new", (event) => {
        // A watcher for a folder the user just left can still be finishing its
        // last pass; its pictures are not this folder's.
        if (belongs(event.payload.path, folder())) add([event.payload])
      })
      if (disposed) {
        unlisten()
        return
      }
      stop = unlisten

      const location = await call<ShotLocation | null>("shots_dir").catch(() => null)
      if (disposed) return
      if (!location) {
        setState("none")
        return
      }
      await watch(location)
    })()
  }

  return {
    shots,
    folder,
    state,
    dismiss: (path) => {
      dismissed.add(path)
      setShots((current) => current.filter((shot) => shot.path !== path))
    },
    remove: async (path) => {
      dismissed.add(path)
      setShots((current) => current.filter((shot) => shot.path !== path))
      if (!inTauri) return
      await call("shot_delete", { path }).catch(() => undefined)
    },
    load: async (path) => {
      if (!inTauri) return null
      const bytes = await call<number[] | null>("shot_bytes", { path }).catch(() => null)
      return bytes ? new Uint8Array(bytes) : null
    },
    notice,
    choosing,
    canChoose: inTauri,
    choose: async () => {
      if (!inTauri || choosing()) return
      setNotice(undefined)
      setChoosing(true)
      let location: ShotLocation | null
      try {
        location = await call<ShotLocation | null>("shots_choose_folder")
      } catch (error) {
        // The host answers with a code; anything else is still a refusal.
        setNotice(NOTICES.includes(String(error)) ? (String(error) as ShotNotice) : "not-saved")
        return
      } finally {
        setChoosing(false)
      }
      if (!location || disposed) return
      // The previous folder's pictures are not the new one's, and keeping them
      // would make the tray look as though it had not changed.
      setShots([])
      await watch(location)
    },
  }
}
