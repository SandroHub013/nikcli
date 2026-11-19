/**
 * Whether Ragù Code is on this machine, asked the same way by Chat and Bot.
 *
 * ADE reads its PATH once, when it starts, and an installer writes the new directory to the user's environment, not to
 * this process (`Host.refreshPath`). Looking up `ragu` in the PATH ADE started with therefore says «missing» for a
 * program that was installed a minute ago. The PATH is reread, as «Ricontrolla» and the new-session form do, but only
 * when the first look found nothing: the usual case (ragu is there) costs one lookup, and where the PATH is reread by
 * a login shell (macOS, Linux) it is not paid for by everyone who has the program.
 */
export interface RaguHost {
  probe?: (command: string, arg: string) => Promise<string | null>
  refreshPath?: () => Promise<boolean>
}

/**
 * The shortest time between two rereads of the PATH, per host. A reread is a registry read on Windows and a login shell
 * on macOS and Linux (up to 8 s), and while ragu is missing every opening of Chat and every focus of Bot asks for one.
 * It stays short on purpose: the sentences promise «riapri» and «quando torni a questa finestra», and an install takes
 * longer than this, so the look made after it still finds a PATH read since.
 */
export const REREAD_GAP_MS = 10_000

interface Reading {
  /** The reread in flight: whoever asks meanwhile waits for it instead of starting another. */
  running?: Promise<void>
  /** When the last one started. */
  at: number
}
const readings = new WeakMap<object, Reading>()

/** True or false, or undefined when there is no host to ask (the browser harness): the caller keeps what it assumed. */
export async function raguFound(
  host: RaguHost | undefined,
  now: () => number = Date.now,
): Promise<boolean | undefined> {
  const probe = host?.probe
  if (!probe) return undefined
  const look = async () => Boolean(await probe("ragu", "--version").catch(() => null))
  if (await look()) return true
  const refresh = host.refreshPath
  if (refresh) {
    const state = readings.get(host) ?? { at: -Infinity }
    readings.set(host, state)
    if (!state.running && now() - state.at >= REREAD_GAP_MS) {
      state.at = now()
      state.running = refresh()
        .catch(() => false)
        .then(() => undefined)
        .finally(() => {
          state.running = undefined
        })
    }
    // Inside the gap and nothing running: the PATH was read a moment ago, and the look above has already used it.
    await state.running
  }
  return look()
}
