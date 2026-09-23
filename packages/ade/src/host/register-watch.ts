/**
 * The decisions and design registers, watched in one pass (P1-C2c).
 *
 * Each register had its own `every(2500)` and listed `.ade/` to stat its own
 * file: two `read_dir` every 2.5 s for one folder, 1.24 invokes a second with
 * the window idle. One timer now, and one listing per folder per pass, handed
 * to both. The 2.5 s stay: `ade-msg registro` promises the button within 3 s.
 */

import { every, type EveryOptions } from "./every"
import type { DirEntry } from "./shell"

export type ReadDir = (path: string) => Promise<DirEntry[]>

export const REGISTERS_WATCH_MS = 2500

export interface WatchedRegister {
  tick: (listing?: ReadDir) => Promise<void>
}

/** One pass: each folder listed at most once, whichever registers ask for it. */
export async function registersPass(registers: readonly WatchedRegister[], readDir: ReadDir | undefined): Promise<void> {
  const listings = new Map<string, Promise<DirEntry[]>>()
  const shared: ReadDir | undefined =
    readDir &&
    ((dir) => {
      let listing = listings.get(dir)
      if (!listing) {
        listing = readDir(dir)
        listings.set(dir, listing)
      }
      return listing
    })
  for (const register of registers) await register.tick(shared)
}

/** Starts the pass every {@link REGISTERS_WATCH_MS}; returns the stop. */
export function watchRegisters(
  registers: readonly WatchedRegister[],
  readDir: () => Promise<ReadDir | undefined>,
  options?: EveryOptions,
): () => void {
  return every(REGISTERS_WATCH_MS, async () => registersPass(registers, await readDir()), { immediate: true, ...options })
}
