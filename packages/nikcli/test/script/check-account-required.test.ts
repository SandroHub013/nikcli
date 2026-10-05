import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { removeTestDirSync } from "../helpers/fs"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const PACKAGE_ROOT = path.join(REPO_ROOT, "packages", "nikcli")
const SCRIPT = path.join(PACKAGE_ROOT, "script", "check-account-required.ts")

/**
 * The script is a static source checker, so its answer must not depend on the
 * ambient environment. The child is therefore spawned with `NIKCLI_*`/`XDG_*`
 * stripped: `bun test` shares one process across every file in a run, so another
 * file's `beforeEach` repointing `NIKCLI_TEST_HOME` at its own temp dir is
 * otherwise inherited by this subprocess — and a child that failed to start looks
 * exactly like a child that found a violation, because both exit 1. The stderr is
 * carried into the failure so the next occurrence says which one it was.
 */
function childEnv() {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith("NIKCLI_") || key.startsWith("XDG_")) continue
    env[key] = value
  }
  return env
}

function runScript(args: string[] = []) {
  const result = spawnSync("bun", ["run", SCRIPT, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: childEnv(),
    timeout: 60_000,
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

describe("check-account-required.ts (EOT-12)", () => {
  it("passes on the real tree", () => {
    const { status, stdout } = runScript()
    expect(status).toBe(0)
    expect(stdout).toContain("account-required guard")
  })

  /**
   * `PRIVILEGED_FILES` is empty on purpose — every surface the guard was
   * written for turned out to be account-optional by design. An empty list
   * that has never been shown to fail is indistinguishable from a check that
   * does nothing, so these cases drive it with a synthetic tree instead.
   */
  describe("with a declared privileged file", () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "nikcli-account-required-"))
      mkdirSync(path.join(dir, "routes"))
    })
    afterEach(() => removeTestDirSync(dir))

    const write = (name: string, body: string) => writeFileSync(path.join(dir, "routes", name), body)

    it("passes when the file imports the guard", () => {
      write("good.ts", 'import { requireAccount } from "@/account/guard"\n')
      const { status, stdout, stderr } = runScript([`--src=${dir}`, "--privileged=routes/good.ts"])
      // Carried into the message: exit 1 is both "found a violation" and "the
      // child never ran", and the two are indistinguishable without it.
      expect(`${status}\n${stdout}\n${stderr}`).toStartWith("0\n")
    })

    it("fails when the file is declared privileged but serves without the guard", () => {
      write("bad.ts", "export const handler = () => new Response()\n")
      const { status, stderr } = runScript([`--src=${dir}`, "--privileged=routes/bad.ts"])
      expect(status).toBe(1)
      expect(stderr).toContain("routes/bad.ts is privileged but does not import @/account/guard")
    })

    it("fails when a declared privileged file does not exist", () => {
      const { status, stderr } = runScript([`--src=${dir}`, "--privileged=routes/gone.ts"])
      expect(status).toBe(1)
      expect(stderr).toContain("missing privileged handler: routes/gone.ts")
    })

    it("checks every declared file, not just the first", () => {
      write("good.ts", 'import { requireAccount } from "@/account/guard"\n')
      write("bad.ts", "export const handler = () => new Response()\n")
      const { status, stdout, stderr } = runScript([`--src=${dir}`, "--privileged=routes/good.ts,routes/bad.ts"])
      // Same reason as above: the status alone cannot tell a finding from a
      // child that died, and this case asserts on both a hit and a clean file.
      expect(`${status}\n${stdout}\n${stderr}`).toContain(
        "routes/bad.ts is privileged but does not import @/account/guard",
      )
      expect(stderr).not.toContain("routes/good.ts")
    })
  })
})
