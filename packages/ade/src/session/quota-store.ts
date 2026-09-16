/**
 * The quota every pane reads, kept in one reactive place and refreshed on a
 * timer.
 *
 * The first version kept the providers in a module-level `Map`. A `Map` is not
 * a signal, so a pane mounted before the first read never learned that a
 * reading had arrived and went on showing whatever it had computed at mount —
 * which, with the fallback figures that version had, was a made-up number
 * forever. Here the snapshot and the clock are signals: a new report and every
 * tick of the countdown reach every pane that shows them.
 *
 * Plain `.ts`, and the reader is injected, so the refresh is tested under
 * `bun test` without a host and without anybody's real quota file.
 */

import { createRoot, createSignal } from "solid-js"
import { every } from "../host/every"
import { AGY_QUOTA_FILE, type AgyQuotaReading, QUOTA_AXI_FILE, type QuotaSnapshot, readAgyQuota, readQuotaAxiSnapshot } from "./quota"

/**
 * How often the report is read again, and the countdown moves.
 *
 * Thirty seconds: the countdown is shown to the minute, and the file is a few
 * kilobytes. The timer pauses while the window is hidden, like every poll in
 * ADE.
 */
export const QUOTA_REFRESH_MS = 30_000

/**
 * How long one read of the report may take.
 *
 * A spawn waits on this read, so a host call that never returns must not hold
 * the spawn with it. The file is a few kilobytes: two seconds is long.
 */
export const QUOTA_READ_TIMEOUT_MS = 2_000

/** Reads a report's text, or `undefined` when there is none. */
export type QuotaReader = () => Promise<string | undefined>

export interface QuotaStore {
  snapshot: () => QuotaSnapshot | undefined
  now: () => number
  /** Reads the report once, now. */
  refresh: () => Promise<void>
  /** Starts the periodic refresh; the returned function stops it. */
  start: (options?: { immediate?: boolean }) => () => void
}

/**
 * `read` gives quota-axi's report; `readAgy` agy's status line file, read
 * alongside it on every refresh.
 */
export function createQuotaStore(
  read: QuotaReader,
  clock: () => number = Date.now,
  timeoutMs: number = QUOTA_READ_TIMEOUT_MS,
  readAgy: QuotaReader = async () => undefined,
): QuotaStore {
  return createRoot(() => {
    const [axi, setAxi] = createSignal<QuotaSnapshot | undefined>()
    const [agy, setAgy] = createSignal<AgyQuotaReading | undefined>()
    const [now, setNow] = createSignal(clock())
    const snapshot = (): QuotaSnapshot | undefined => {
      const report = axi()
      const reading = agy()
      if (!reading) return report
      return report ? { ...report, agy: reading } : { providers: {}, axiMissing: true, agy: reading }
    }

    /** Reads one file within the timeout; `false` when the read itself failed. */
    const load = async (reader: QuotaReader): Promise<string | undefined | false> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          reader(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)
          }),
        ])
      } catch {
        return false
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    /** Applies one file's text: failure keeps, absence clears, half-written keeps. */
    const apply = <T,>(text: string | undefined | false, parse: (raw: unknown) => T | undefined, set: (value: T | undefined) => void) => {
      if (text === false) return
      if (!text) return set(undefined)
      try {
        set(parse(JSON.parse(text)))
      } catch {
        // Half-written: keep what was read last.
      }
    }

    /*
     * A read that fails keeps the last reading; only a read that finds no
     * report clears it.
     *
     * Failing is a hiccup of the read — a timeout, a file caught half-written
     * — and says nothing about the quota, so it should not blank six panes
     * for thirty seconds. The last reading is not trusted forever for that:
     * `quotaForAgent` turns it into "n/d" once it is older than
     * `QUOTA_STALE_MS`, however it was kept.
     */
    const refresh = async () => {
      const [axiText, agyText] = await Promise.all([load(read), load(readAgy)])
      apply(axiText, readQuotaAxiSnapshot, (value) => setAxi(() => value))
      apply(agyText, readAgyQuota, (value) => setAgy(() => value))
      setNow(clock())
    }

    return {
      snapshot,
      now,
      refresh,
      start: (options = {}) => every(QUOTA_REFRESH_MS, refresh, { immediate: options.immediate ?? true }),
    }
  })
}

/** A file under the user's home, read through the Tauri host; nothing outside it. */
function readFromHome(file: readonly string[]): QuotaReader {
  return async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const home = await invoke<string>("home_dir")
    if (!home) return undefined
    const sep = home.includes("\\") ? "\\" : "/"
    const result = await invoke<{ text: string }>("read_text_file", {
      path: [home, ...file].join(sep),
      maxBytes: 1_000_000,
    })
    return result?.text
  }
}

const readFromHost = readFromHome(QUOTA_AXI_FILE)
const readAgyFromHost = readFromHome(AGY_QUOTA_FILE)

let shared: QuotaStore | undefined

/**
 * The shared store after one fresh read, without starting its timer.
 *
 * For a decision taken now (the spawn picker), where holding the store would
 * start the periodic refresh and its immediate read on top of this one.
 */
export async function freshSharedQuota(): Promise<QuotaStore> {
  shared ??= createQuotaStore(readFromHost, Date.now, QUOTA_READ_TIMEOUT_MS, readAgyFromHost)
  await shared.refresh()
  return shared
}

let users = 0
let stop: (() => void) | undefined

/**
 * The app's one quota store, started while any pane shows it.
 *
 * Counted rather than started at import: importing a module must not begin
 * polling the disk, and six panes must not start six timers.
 */
export function useSharedQuota(): { store: QuotaStore; release: () => void } {
  shared ??= createQuotaStore(readFromHost, Date.now, QUOTA_READ_TIMEOUT_MS, readAgyFromHost)
  users++
  if (users === 1) stop = shared.start()
  let released = false
  return {
    store: shared,
    release: () => {
      if (released) return
      released = true
      users--
      if (users === 0) {
        stop?.()
        stop = undefined
      }
    },
  }
}
