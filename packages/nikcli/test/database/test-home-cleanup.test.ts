import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { removeTestDirSync } from "../helpers/fs"

const ROOT = path.resolve(import.meta.dir, "../..")

/*
 * `bun test` fires neither "exit" nor "beforeExit", so a home made by `test/isolate.ts` used to stay until
 * a later run swept it, six hours on. The preload now removes it in a hook that runs once, after the last
 * file. Tried with a whole `bun test` of one trivial file, in a temp dir of its own so that what is left
 * behind can be counted.
 */
function runTrivialSuite(env: Record<string, string>) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "nikcli-home-cleanup-"))
  const temp = path.join(scratch, "temp")
  const work = path.join(scratch, "work")
  mkdirSync(temp)
  mkdirSync(work)
  writeFileSync(
    path.join(work, "trivial.test.ts"),
    `import { expect, it } from "bun:test"\nit("runs", () => { expect(process.env.NIKCLI_TEST_HOME).toBeTruthy() })\n`,
  )
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("NIKCLI_") || key.startsWith("XDG_")) continue
    clean[key] = value
  }
  try {
    const run = Bun.spawnSync([process.execPath, "test", path.join(work, "trivial.test.ts")], {
      cwd: ROOT,
      env: { ...clean, TEMP: temp, TMP: temp, TMPDIR: temp, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    return {
      code: run.exitCode,
      output: run.stdout.toString() + run.stderr.toString(),
      homes: readdirSync(temp).filter((name) => name.startsWith("nikcli-test-home-")),
      temp,
    }
  } finally {
    removeTestDirSync(scratch)
  }
}

describe("the test home of a run", () => {
  it("is removed after the last file, when the run made it", () => {
    const run = runTrivialSuite({})

    expect(run.output).toContain("1 pass")
    expect(run.code).toBe(0)
    // Without the hook the folder of this very run is still here.
    expect(run.homes).toEqual([])
  })

  it("is left alone when NIKCLI_TEST_HOME came from outside", () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "nikcli-outside-home-"))
    try {
      const run = runTrivialSuite({ NIKCLI_TEST_HOME: outside })

      expect(run.code).toBe(0)
      expect(existsSync(outside)).toBe(true)
    } finally {
      removeTestDirSync(outside)
    }
  })
})
