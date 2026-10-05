/**
 * The world's opening, as the panel watches it (old PCs, point 3), and the level ADE remembers it was lowered to.
 *
 * An opening that is not on screen in 30 s says so: «Il mondo non si è aperto: riprova, oppure apri la lista»,
 * instead of a panel that hangs. Only time the panel could be seen counts: a hidden window stops the world's frames
 * (Chromium holds `requestAnimationFrame`), and that is not a failed opening.
 *
 * When the frames stay too slow at Media the world says `slow`; ADE keeps that for a week and opens it at Bassa.
 */

export const OPEN_TIMEOUT_MS = 30_000

export interface OpenWatchDeps {
  /** Runs `run` after `ms`; the returned function cancels it. */
  schedule: (run: () => void, ms: number) => () => void
  /** Whether the panel can be seen and the world is not paused. */
  visible: () => boolean
  /** The world did not open in time. */
  late: () => void
}

export function createOpenWatch(deps: OpenWatchDeps) {
  let cancel: (() => void) | undefined
  /** Waiting for an opening (started, not opened yet). */
  let waiting = false
  const arm = () => {
    cancel = deps.schedule(() => {
      cancel = undefined
      // Not seen at the end of the wait: the frames may have been held, so it waits again, whole.
      if (!deps.visible()) return arm()
      waiting = false
      deps.late()
    }, OPEN_TIMEOUT_MS)
  }
  return {
    /** A new load of the frame: the wait starts again. */
    start() {
      cancel?.()
      waiting = true
      arm()
    },
    /** The panel can be seen again: the time it was hidden does not count, the wait starts again, whole. */
    seenAgain() {
      if (!waiting) return
      cancel?.()
      arm()
    },
    /** The world is on screen. */
    opened() {
      waiting = false
      cancel?.()
      cancel = undefined
    },
    dispose() {
      waiting = false
      cancel?.()
      cancel = undefined
    },
  }
}

export const LOWERED_KEY = "ade.nikverse.lowered"
/** How long ADE keeps a world lowered to Bassa: a week, then it tries the machine's own level again. */
export const LOWERED_FOR_MS = 7 * 24 * 3600 * 1000

export interface LoweredStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function createLoweredStore(storage: LoweredStorage | undefined, now: () => number = Date.now) {
  let at: number | undefined
  let read = false
  const load = () => {
    if (read) return at
    read = true
    try {
      const value = Number(JSON.parse(storage?.getItem(LOWERED_KEY) ?? "null")?.at)
      if (Number.isFinite(value)) at = value
    } catch {
      /* storage may throw or hold something else: not lowered */
    }
    return at
  }
  return {
    /** Whether the world opens at Bassa because it was too slow, less than a week ago. */
    lowered(): boolean {
      const when = load()
      return when !== undefined && now() >= when && now() - when < LOWERED_FOR_MS
    },
    lower(): void {
      at = now()
      read = true
      try {
        storage?.setItem(LOWERED_KEY, JSON.stringify({ at }))
      } catch {
        /* the copy in memory holds it for this session */
      }
    },
  }
}

/**
 * The query of the world's address: the test build's bench door, the level ADE lowered it to, and `city=0` for the
 * list the user chose after a failed opening.
 */
export function worldQuery(options: { bench?: string; lowered?: boolean; list?: boolean }): string {
  const parts = [options.bench, options.lowered ? "quality=bassa&lowered=1" : "", options.list ? "city=0" : ""].filter(Boolean)
  return parts.length ? `?${parts.join("&")}` : ""
}
