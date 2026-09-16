/**
 * Asks GitHub for new ADE releases, and says so once per version.
 *
 * The first check waits a little after launch, so start-up is not paying for
 * a network round trip; after that it repeats often enough that a release
 * published while the window is open is noticed in minutes rather than in
 * half an hour. Failures are silent unless someone asked: being offline is
 * not something the bell should report by itself.
 *
 * Three things decide when a check happens, and all three exist because the
 * releases people wait for arrive while they are doing something else:
 *
 *   - the timer, `CHECK_EVERY_MS`, for a window left open;
 *   - the window coming back to the front, which is when someone is looking;
 *   - the machine waking up, noticed as a jump in the clock, because timers
 *     do not fire while it sleeps and the release may be hours old by then.
 *
 * A hidden window never checks. Nobody is reading it, and a dozen windows
 * polling in the background is exactly how an IP runs out of GitHub's sixty
 * unauthenticated calls an hour.
 *
 * What keeps ADE inside that budget:
 *
 *   - `MIN_CHECK_GAP_MS` between two calls, whatever asked for them;
 *   - `MAX_CALLS_PER_HOUR`, counted over a moving hour, below sixty on
 *     purpose: the same IP may have another ADE window, or a git tool;
 *   - `If-None-Match`. GitHub answers an unchanged list with `304` and does
 *     not charge it to the limit, so a window that checks every three minutes
 *     and sees no new release spends almost nothing.
 */
import { newerRelease, RELEASE_REPO, type AvailableUpdate, type GithubRelease } from "./release"

/** After launch, once the window has drawn. */
export const FIRST_CHECK_MS = 15_000

/**
 * Between two timed checks.
 *
 * Three minutes: the user asked to hear about a release "as soon as it is
 * out", and thirty minutes was that wait. With `If-None-Match` the usual
 * answer is a `304`, which costs nothing.
 */
export const CHECK_EVERY_MS = 3 * 60_000

/** No two calls closer than this, however many things ask at once. */
export const MIN_CHECK_GAP_MS = 60_000

/**
 * Calls in any one hour, counting only the ones GitHub charges for.
 *
 * The unauthenticated limit is sixty per hour per IP, shared with everything
 * else on the machine that talks to the API.
 */
export const MAX_CALLS_PER_HOUR = 40

/** How much later than expected a timer has to fire to mean the machine slept. */
export const WAKE_GAP_MS = 2 * 60_000

/** How often the clock is looked at to notice a sleep. */
export const WAKE_POLL_MS = 30_000

/** What a check found, for whoever asked for it. */
export type CheckStatus =
  /** A release newer than this build, not announced yet. */
  | "update"
  /** This build is the newest release. */
  | "current"
  /** GitHub said nothing changed since the last look. */
  | "unchanged"
  /** Not asked: too soon, out of budget, or the window is hidden. */
  | "skipped"
  /** The request failed. */
  | "error"

export interface CheckResult {
  readonly status: CheckStatus
  readonly at: number
  /** Present when `status` is `update`. */
  readonly update?: AvailableUpdate
  /** The running build's version, when it was read. */
  readonly currentVersion?: string
  /** Why it was skipped, or what failed; a sentence for a person. */
  readonly problem?: string
}

/** One look at the releases, or `notModified` when GitHub says nothing changed. */
export interface ReleaseFeedResult {
  readonly releases?: readonly GithubRelease[]
  readonly notModified: boolean
}

export interface ReleaseFeed {
  read(): Promise<ReleaseFeedResult>
}

export interface UpdateWatchOptions {
  /** The running build's version; `0.0.0` for dev builds. */
  readonly currentVersion: () => Promise<string>
  readonly onUpdate: (update: AvailableUpdate) => void
  readonly feed?: ReleaseFeed
  /** Whether the window is on screen. A hidden one is never checked. */
  readonly isVisible?: () => boolean
  readonly now?: () => number
  /** Subscribes to "the window came back"; returns the unsubscribe. */
  readonly onForeground?: (run: () => void) => () => void
}

/**
 * GitHub's release list, asked for with the tag it last answered with.
 *
 * The whole list rather than `releases/latest`: this repository carries
 * nikcli's releases and other products' too, and `latest` is whichever was
 * published last, which is usually not ADE's. The filtering is in
 * `newerRelease`, so the list has to be the one that contains `ade-v*`.
 */
export function githubReleaseFeed(doFetch: typeof fetch = fetch): ReleaseFeed {
  let etag: string | undefined
  return {
    async read(): Promise<ReleaseFeedResult> {
      const response = await doFetch(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`, {
        headers: {
          Accept: "application/vnd.github+json",
          ...(etag ? { "If-None-Match": etag } : {}),
        },
      })
      // Not charged to the rate limit, which is what makes a short interval affordable.
      if (response.status === 304) return { notModified: true }
      if (!response.ok) throw new Error(`GitHub ${response.status}`)
      const tag = response.headers.get("etag")
      if (tag) etag = tag
      return { releases: (await response.json()) as GithubRelease[], notModified: false }
    },
  }
}

/** Kept for callers that only want the list. */
export async function fetchReleases(): Promise<readonly GithubRelease[]> {
  const { releases } = await githubReleaseFeed().read()
  return releases ?? []
}

export interface UpdateWatch {
  /** Starts the timers and the listeners; call once. */
  start(): void
  stop(): void
  /**
   * Checks now, for someone who asked.
   *
   * `force` skips the wait between calls — a person pressing "Controlla
   * aggiornamenti" is not a background poll — but never the hourly budget,
   * which is the one that protects the limit.
   */
  check(options?: { force?: boolean }): Promise<CheckResult>
}

export function createUpdateWatch(options: UpdateWatchOptions): UpdateWatch {
  const now = options.now ?? Date.now
  const feed = options.feed ?? githubReleaseFeed()
  const visible = options.isVisible ?? (() => true)
  const announced = new Set<string>()
  /** When each charged call was made, over the last hour. */
  const charged: number[] = []
  let lastCallAt: number | undefined
  let timers: ReturnType<typeof setTimeout>[] = []
  let unsubscribe: (() => void) | undefined
  let lastTick = now()

  const budgetLeft = (at: number): boolean => {
    while (charged.length > 0 && at - charged[0]! >= 60 * 60_000) charged.shift()
    return charged.length < MAX_CALLS_PER_HOUR
  }

  const check = async (opts: { force?: boolean } = {}): Promise<CheckResult> => {
    const at = now()
    if (!opts.force && !visible()) {
      return { status: "skipped", at, problem: "La finestra non è in primo piano." }
    }
    if (!opts.force && lastCallAt !== undefined && at - lastCallAt < MIN_CHECK_GAP_MS) {
      return { status: "skipped", at, problem: "Controllato da poco." }
    }
    if (!budgetLeft(at)) {
      return { status: "skipped", at, problem: "Troppi controlli in un'ora: riprovo più tardi." }
    }
    lastCallAt = at
    try {
      const [currentVersion, result] = await Promise.all([options.currentVersion(), feed.read()])
      if (result.notModified) return { status: "unchanged", at, currentVersion }
      charged.push(at)
      const update = newerRelease(currentVersion, result.releases ?? [])
      if (!update) return { status: "current", at, currentVersion }
      if (announced.has(update.version)) return { status: "update", at, currentVersion, update }
      announced.add(update.version)
      options.onUpdate(update)
      return { status: "update", at, currentVersion, update }
    } catch (error) {
      // A charged call all the same: GitHub counted the request that failed.
      charged.push(at)
      return { status: "error", at, problem: error instanceof Error ? error.message : String(error) }
    }
  }

  const background = () => void check().catch(() => {})

  return {
    start() {
      timers.push(setTimeout(background, FIRST_CHECK_MS))
      timers.push(setInterval(background, CHECK_EVERY_MS) as unknown as ReturnType<typeof setTimeout>)
      /*
       * A sleeping machine fires no timers: on waking, the interval would
       * wait its full turn before looking, and the release published in the
       * meantime would arrive minutes late. A clock that jumped further than
       * this poll could account for is that wake.
       */
      lastTick = now()
      timers.push(
        setInterval(() => {
          const at = now()
          const slept = at - lastTick > WAKE_POLL_MS + WAKE_GAP_MS
          lastTick = at
          if (slept) background()
        }, WAKE_POLL_MS) as unknown as ReturnType<typeof setTimeout>,
      )
      unsubscribe = options.onForeground?.(background)
    },
    stop() {
      for (const timer of timers) {
        clearTimeout(timer)
        clearInterval(timer as unknown as ReturnType<typeof setInterval>)
      }
      timers = []
      unsubscribe?.()
      unsubscribe = undefined
    },
    check,
  }
}

/**
 * What the bell says about a check somebody asked for.
 *
 * Every outcome gets a line, "nothing new" included: a command that answers
 * only when there is an update leaves the user pressing it again to find out
 * whether it did anything.
 */
export function checkMessage(result: CheckResult): { kind: "info" | "error"; text: string; href?: string } {
  switch (result.status) {
    case "update":
      return {
        kind: "info",
        text: `ADE ${result.update?.version} è disponibile`,
        ...(result.update ? { href: result.update.url } : {}),
      }
    case "current":
    case "unchanged":
      return {
        kind: "info",
        text: result.currentVersion
          ? `Nessun aggiornamento: ADE ${result.currentVersion} è l'ultima versione.`
          : "Nessun aggiornamento disponibile.",
      }
    case "skipped":
      return { kind: "info", text: result.problem ?? "Controllo saltato." }
    case "error":
      return { kind: "error", text: `Non sono riuscito a controllare gli aggiornamenti: ${result.problem}` }
  }
}

/** Starts watching; the returned function stops it. */
export function startUpdateWatch(options: UpdateWatchOptions): () => void {
  const watch = createUpdateWatch(options)
  watch.start()
  return () => watch.stop()
}
