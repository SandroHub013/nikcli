import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync } from "fs"
import os from "os"
import path from "path"
import { removeTestDirSync } from "../helpers/fs"

const ROOT = path.resolve(import.meta.dir, "../..")
const slash = (value: string) => value.replaceAll("\\", "/")

/*
 * `test/isolate.ts` runs as the first import of the preload, so it is tried here in a process of its own,
 * with an environment built by hand: a fake user home, a temp dir elsewhere (Linux and macOS: /tmp, outside
 * HOME) and a NIKCLI_TEST_HOME that was set from outside, inside the home — what a CI that uses
 * `${{ runner.temp }}` does (/home/runner/work/_temp, under HOME=/home/runner).
 */
function underFakeUser<T>(setUp: (fake: { home: string; elsewhere: string; testHome: string }) => T): T {
  const root = mkdtempSync(path.join(os.tmpdir(), "nikcli-isolate-env-"))
  const home = path.join(root, "home")
  const elsewhere = path.join(root, "elsewhere")
  const testHome = path.join(home, "work", "_temp", "nikcli-test")
  try {
    for (const dir of [home, elsewhere, testHome]) mkdirSync(dir, { recursive: true })
    return setUp({ home, elsewhere, testHome })
  } finally {
    removeTestDirSync(root)
  }
}

function childEnv(fake: { home: string; elsewhere: string; testHome: string }, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    // What the parent's own preload set must not leak in: the child decides for itself.
    if (value === undefined || key.startsWith("NIKCLI_") || key.startsWith("XDG_")) continue
    env[key] = value
  }
  return {
    ...env,
    HOME: fake.home,
    USERPROFILE: fake.home,
    LOCALAPPDATA: path.join(fake.home, "AppData", "Local"),
    APPDATA: path.join(fake.home, "AppData", "Roaming"),
    TEMP: fake.elsewhere,
    TMP: fake.elsewhere,
    TMPDIR: fake.elsewhere,
    NIKCLI_TEST_MODE: "1",
    ...extra,
  }
}

describe("test/isolate.ts when NIKCLI_TEST_HOME is set from outside", () => {
  it("allows a test home that sits inside the user's home but outside the temp dir", () => {
    const result = underFakeUser((fake) => {
      const script = `
        import ${JSON.stringify(slash(path.join(ROOT, "test/isolate.ts")))}
        import { realFolderOf } from ${JSON.stringify(slash(path.join(ROOT, "src/database/test-guard.ts")))}
        const db = process.env.NIKCLI_TEST_HOME + "/data/nikcli.db"
        console.log(JSON.stringify({ found: realFolderOf(db) ?? null, allowed: process.env.NIKCLI_TEST_ALLOWED_DIRS }))
      `
      const run = Bun.spawnSync([process.execPath, "-e", script], {
        env: childEnv(fake, { NIKCLI_TEST_HOME: fake.testHome }),
        stdout: "pipe",
        stderr: "pipe",
      })
      return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString(), fake }
    })

    expect(result.err).toBe("")
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.out.trim().split("\n").at(-1)!) as { found: string | null; allowed: string }
    // Without the fix the guard names the fake user home: the test home is not among the allowed folders.
    expect(parsed.found).toBeNull()
    expect(parsed.allowed.toLowerCase()).toContain(path.resolve(result.fake.testHome).toLowerCase())
  })
})
