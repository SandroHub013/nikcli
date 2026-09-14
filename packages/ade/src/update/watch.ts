/**
 * Asks GitHub for new ADE releases, and says so once per version.
 *
 * The first check waits a little after launch, so start-up is not paying for
 * a network round trip; after that it repeats on a slow timer, which is what
 * makes a release reach a window that stays open for days. Failures are
 * silent: being offline is not something the bell should report.
 */
import { newerRelease, RELEASE_REPO, type AvailableUpdate, type GithubRelease } from "./release"

export const FIRST_CHECK_MS = 15_000
export const CHECK_EVERY_MS = 30 * 60_000

export interface UpdateWatchOptions {
  /** The running build's version; `0.0.0` for dev builds. */
  readonly currentVersion: () => Promise<string>
  readonly onUpdate: (update: AvailableUpdate) => void
  readonly fetchReleases?: () => Promise<readonly GithubRelease[]>
}

export async function fetchReleases(): Promise<readonly GithubRelease[]> {
  const response = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`, {
    headers: { Accept: "application/vnd.github+json" },
  })
  if (!response.ok) throw new Error(`GitHub ${response.status}`)
  return (await response.json()) as GithubRelease[]
}

/**
 * One check: the update, when there is one not yet announced.
 *
 * `announced` is kept by the caller so a version is reported once per run,
 * not every thirty minutes.
 */
export async function checkOnce(
  options: UpdateWatchOptions,
  announced: Set<string>,
): Promise<AvailableUpdate | undefined> {
  const [current, releases] = await Promise.all([
    options.currentVersion(),
    (options.fetchReleases ?? fetchReleases)(),
  ])
  const update = newerRelease(current, releases)
  if (!update || announced.has(update.version)) return undefined
  announced.add(update.version)
  return update
}

/** Starts watching; the returned function stops it. */
export function startUpdateWatch(options: UpdateWatchOptions): () => void {
  const announced = new Set<string>()
  const run = () => {
    checkOnce(options, announced)
      .then((update) => update && options.onUpdate(update))
      .catch(() => {})
  }
  const first = setTimeout(run, FIRST_CHECK_MS)
  const every = setInterval(run, CHECK_EVERY_MS)
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}
