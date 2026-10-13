/**
 * NikVerse's assets, fetched the first time the world is opened: what the panel shows and when it starts the frame.
 *
 * The host (`src-tauri/src/nikverse_assets.rs`) does the fetching and checks every file against the list the binary was built with; this is the
 * panel's end of it. A `.ts` and not in the `.tsx`, so the order of things is tested: the frame is not started while the files are on their way
 * (it would load once with placeholders and again with the files), it is started when they are in, and where they cannot be fetched (no network, a
 * release without them) the world starts with the placeholders it already has and says why, with a way to try again.
 */

/** What `nikverse_assets_status` answers (the host's field names). */
export interface AssetsStatus {
  /** Nothing to fetch: every file is in place (always, in a debug build). */
  ready: boolean
  missing_files: number
  missing_bytes: number
  running: boolean
  files_done: number
  files_total: number
  bytes_done: number
  bytes_total: number
  /** Why the last fetch stopped, in the user's words. */
  error: string | null
}

/** The commands of the host facade this needs; each may be missing (a browser tab, an older host). */
export interface AssetsHost {
  nikverseAssetsStatus?: () => Promise<AssetsStatus>
  nikverseAssetsInstall?: () => Promise<void>
}

/** What the panel shows. */
export type AssetsView =
  /** Nothing to say: the frame is (or is about to be) up with its files. */
  | { kind: "ready" }
  /** The files are on their way: the panel shows the progress and holds the frame back. */
  | { kind: "fetching"; percent?: number; megabytes: number }
  /** The files could not be fetched: the world starts with its placeholders, and the panel says why and offers another try. */
  | { kind: "failed"; reason: string }

const MB = 1024 * 1024

/** The view of a fetch that is running, from the host's progress (a percentage only when the total is known). */
export function fetchingView(status: Pick<AssetsStatus, "bytes_done" | "bytes_total" | "missing_bytes">): AssetsView {
  const total = status.bytes_total > 0 ? status.bytes_total : status.missing_bytes
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((status.bytes_done / total) * 100))) : undefined
  return { kind: "fetching", percent, megabytes: Math.max(0.1, Math.round((total / MB) * 10) / 10) }
}

export interface AssetsFlowDeps {
  host: AssetsHost | undefined
  /** The view changed. */
  view: (view: AssetsView) => void
  /** The frame may start (or restart): `complete` is whether the files are in place, false when the world goes on with its placeholders. */
  ready: (complete: boolean) => void
  /** Runs `fn` after `ms`; returns how to cancel it. */
  schedule: (fn: () => void, ms: number) => () => void
}

export interface AssetsFlow {
  /** Looks at what the host has and fetches what is missing. Safe to call again: a second call while one runs does nothing. */
  start(): Promise<void>
  /** Stops reading the progress (the panel is gone). The fetch itself goes on in the host and is finished by the next `start`. */
  dispose(): void
}

/** How often the progress is read while a fetch runs. */
export const POLL_MS = 400

export function createAssetsFlow(deps: AssetsFlowDeps): AssetsFlow {
  let running = false
  let disposed = false
  let cancelPoll: (() => void) | undefined

  const stopPolling = () => {
    cancelPoll?.()
    cancelPoll = undefined
  }

  const poll = (read: () => Promise<AssetsStatus>) => {
    const tick = () => {
      cancelPoll = deps.schedule(async () => {
        if (disposed) return
        const status = await read().catch(() => undefined)
        if (disposed || !running) return
        if (status?.running) deps.view(fetchingView(status))
        tick()
      }, POLL_MS)
    }
    tick()
  }

  return {
    async start() {
      if (running || disposed) return
      const read = deps.host?.nikverseAssetsStatus
      const install = deps.host?.nikverseAssetsInstall
      // No host to ask (a browser tab, an older host): the world starts as it is, as it did before the files were fetched.
      if (!read || !install) return deps.ready(true)
      running = true
      try {
        const first = await read().catch(() => undefined)
        if (disposed) return
        if (!first || first.ready) {
          deps.view({ kind: "ready" })
          return deps.ready(true)
        }
        deps.view(fetchingView(first))
        poll(read)
        const failure = await install().then(
          () => undefined,
          (error: unknown) => (error instanceof Error ? error.message : String(error ?? "")).trim() || "errore sconosciuto",
        )
        stopPolling()
        if (disposed) return
        if (failure) {
          deps.view({ kind: "failed", reason: failure })
          // The world starts with what it has: a missing file is a placeholder, not a reason to show nothing.
          return deps.ready(false)
        }
        deps.view({ kind: "ready" })
        deps.ready(true)
      } finally {
        stopPolling()
        running = false
      }
    },
    dispose() {
      disposed = true
      stopPolling()
    },
  }
}
