import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, final test of package C: the source names neither nikcli-ai.dev nor nikcli.store. Out of
 * scope by the brief: LICENSE, the codemod (script/ragu-codemod*), and the tests, which name the hosts to prove they
 * are never called.
 *
 * The history (CHANGELOG, specs, plans) is allowed: it records what was done or planned at the time. Package A's
 * leftovers were closed when it was merged with package C, so no list of owners is left. Any other file fails.
 */
const ROOT = path.join(import.meta.dir, "../../../..")
const NIK = /nikcli-ai\.dev|nikcli\.store/

// Records of what was done or planned at the time: they are history, not instructions.
const HISTORY = ["CHANGELOG.md", "specs/", ".nikcli/plans/"]

const OUT_OF_SCOPE = (file: string) =>
  file === "LICENSE" ||
  file.startsWith("script/ragu-codemod") ||
  /(^|\/)(test|tests|e2e|__tests__)\//.test(file) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)

const allowed = (file: string) =>
  HISTORY.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry))

function tracked(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  expect(out.exitCode).toBe(0)
  return out.stdout.toString().split("\0").filter(Boolean)
}

describe("no host of Nik", () => {
  test("no tracked source names nikcli-ai.dev or nikcli.store, but the history", () => {
    const hits = tracked()
      .filter((file) => !OUT_OF_SCOPE(file) && !allowed(file))
      .filter((file) => {
        const full = path.join(ROOT, file)
        return fs.existsSync(full) && fs.statSync(full).isFile() && NIK.test(fs.readFileSync(full, "latin1"))
      })
    expect(hits).toEqual([])
  })
})
