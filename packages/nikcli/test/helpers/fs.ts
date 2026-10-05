import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * Removal options shared by every test temp-dir cleanup.
 *
 * `maxRetries`/`retryDelay` make `fs.rm` itself wait out the short window where
 * Windows still holds a just-closed handle (a SQLite database is the usual
 * culprit). `force` keeps a missing directory from being an error, so cleanup
 * can run unconditionally.
 */
const REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
} as const

/**
 * Release the handles that a retry loop cannot outwait.
 *
 * `Database.close()` reports success on Windows and the file stays locked
 * anyway: `bun:sqlite` keeps the native handle alive until the wrapper object
 * is collected, and a plain retry just re-fails with EBUSY. A forced
 * synchronous collection is what actually hands the file back, and it costs
 * nothing on the happy path because this only runs after a failed removal.
 */
function collectLockedHandles(): void {
  try {
    ;(globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc?.(true)
  } catch {}
}

/**
 * Remove a temp directory a test suite created, tolerating Windows file locks.
 *
 * Windows refuses to delete a file any process still holds open, and most
 * suites here open the session SQLite database without closing it. A plain
 * `fs.rm(recursive)` in `afterAll` then throws EBUSY and fails the whole file
 * on Windows while passing everywhere else.
 *
 * Cleanup is never allowed to fail a test: after the retries and the forced
 * collection are exhausted the directory is left to the OS, a log line records
 * it, and the caller carries on. Leaking a temp dir costs disk; failing 180
 * files because a handle was late costs the whole signal the suite exists to
 * produce.
 */
export async function removeTestDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, REMOVE_OPTIONS)
    return
  } catch (error) {
    collectLockedHandles()
    try {
      await fs.rm(dir, REMOVE_OPTIONS)
    } catch {
      reportTempDirLeftover(dir, error)
    }
  }
}

/**
 * Synchronous {@link removeTestDir} for suites whose hooks are not async.
 *
 * Same contract: retries Windows locks, never throws, logs the leftover.
 */
export function removeTestDirSync(dir: string): void {
  try {
    rmSync(dir, REMOVE_OPTIONS)
    return
  } catch (error) {
    collectLockedHandles()
    try {
      rmSync(dir, REMOVE_OPTIONS)
    } catch {
      reportTempDirLeftover(dir, error)
    }
  }
}

function reportTempDirLeftover(dir: string, error: unknown): void {
  // SAFETY: this only runs with whatever `fs.rm` rejected with, and Node
  // rejects filesystem calls with an `ErrnoException`.
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown"
  console.warn(`[test] could not remove temp dir ${dir} (${code}); leaving it to the OS`)
}

/**
 * Create a directory symlink that an unprivileged Windows user can also create.
 *
 * Symlinks there need SeCreateSymbolicLinkPrivilege — Developer Mode or an
 * elevated shell — so a plain `fs.symlink` throws EPERM on a default developer
 * machine. Junctions need no privilege and are indistinguishable for what these
 * tests assert: `lstat` reports a symbolic link, `realpath` resolves through
 * them, and the target need not exist yet. Junction targets must be absolute,
 * so a relative target is resolved against the link's own directory, which is
 * what `fs.symlink` means by it.
 */
export async function symlinkDir(target: string, linkPath: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.symlink(path.resolve(path.dirname(linkPath), target), linkPath, "junction")
    return
  }
  await fs.symlink(target, linkPath)
}

let fileSymlinkSupport: boolean | undefined

/**
 * Whether this host can create *file* symlinks.
 *
 * Junctions are directory-only, so a test that needs a link to a file has no
 * unprivileged Windows equivalent and can only be skipped there. Probed once
 * rather than assumed from the platform: Developer Mode and elevated shells
 * both make it work, and CI should not silently lose the coverage.
 */
export function canCreateFileSymlinks(): boolean {
  if (fileSymlinkSupport !== undefined) return fileSymlinkSupport
  const probe = mkdtempSync(path.join(os.tmpdir(), "nikcli-symlink-probe-"))
  try {
    writeFileSync(path.join(probe, "target.txt"), "probe")
    symlinkSync(path.join(probe, "target.txt"), path.join(probe, "link.txt"))
    fileSymlinkSupport = true
  } catch {
    fileSymlinkSupport = false
  } finally {
    try {
      rmSync(probe, { recursive: true, force: true })
    } catch {
      // Same Windows lock the remover above tolerates; the OS reclaims temp.
    }
  }
  return fileSymlinkSupport
}
