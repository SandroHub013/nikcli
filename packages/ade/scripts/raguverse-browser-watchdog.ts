/**
 * The last line of `src/nikverse/browser-guard.ts`: a process of its own that outlives a script killed hard.
 *
 *   bun scripts/nikverse-browser-watchdog.ts <owner pid> <profile> <max ms> [program pattern]
 *
 * Watches the owner. When the owner is gone, or the time is up, or the profile has been removed (the owner closed its
 * browser), it kills whatever still names the profile, removes the profile, and leaves. It watches the owner and the
 * folder, never a browser pid: the browser's launcher exits at once and its pid says nothing. Never longer than `max ms`
 * plus a minute.
 */

import { existsSync, rmSync } from "node:fs"
import { isAlive, killByProfile } from "../src/nikverse/browser-guard"

const [owner, profile, maxMs] = [Number(process.argv[2]), process.argv[3], Number(process.argv[4])]
const program = process.argv[5] || undefined
if (!owner || !profile) process.exit(2)

const until = Date.now() + (maxMs || 45 * 60_000) + 60_000
while (isAlive(owner) && existsSync(profile) && Date.now() < until) await Bun.sleep(500)

killByProfile(profile, program, 20_000)
for (let i = 0; i < 10; i++) {
  try {
    rmSync(profile, { recursive: true, force: true })
    break
  } catch {
    await Bun.sleep(500)
  }
}
process.exit(0)
