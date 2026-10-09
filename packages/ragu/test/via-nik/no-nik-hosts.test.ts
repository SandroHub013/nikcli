import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, final test of package C: the source names neither nikcli-ai.dev nor nikcli.store. Out of
 * scope by the brief: LICENSE, the codemod (script/ragu-codemod*), and the tests, which name the hosts to prove they
 * are never called.
 *
 * Three lists are still allowed, each with its owner. A file leaves its list when its owner removes the hosts; an
 * entry that no longer matches does not fail the test, so the lists only shrink. Any other file with a Nik host fails.
 */
const ROOT = path.join(import.meta.dir, "../../../..")
const NIK = /nikcli-ai\.dev|nikcli\.store/

// Package A (Nik's account and Zen), still on its own branch.
const PACKAGE_A = [
  "packages/llm/src/providers/ragu-inference.ts",
  "packages/ragu/src/account/index.ts",
  "packages/ragu/src/account/url.ts",
  "packages/ragu/src/auth/index.ts",
  "packages/ragu/src/cli/handlers/auth/login.ts",
  "packages/ragu/src/provider/ragu-inference.ts",
  "packages/ragu/src/session/llm/llm-event-adapter.ts",
  "packages/ragu/src/session/retry.ts",
  "packages/tui/src/app.tsx",
  "packages/tui/src/component/dialog-account-login.tsx",
  "packages/tui/src/component/dialog-login.tsx",
  "packages/tui/src/component/dialog-provider.tsx",
]

// Nik's backends and sites that no package imports: waiting for the decision to remove them like packages/console.
const WAITING = [
  "packages/cloud/",
  "packages/enterprise/",
  "packages/identity/",
  "packages/inference/",
  "packages/inference-dashboard/",
  "packages/web/",
]

// Records of what was done or planned at the time: they are history, not instructions.
const HISTORY = ["CHANGELOG.md", "specs/", ".nikcli/plans/"]

const OUT_OF_SCOPE = (file: string) =>
  file === "LICENSE" ||
  file.startsWith("script/ragu-codemod") ||
  /(^|\/)(test|tests|e2e|__tests__)\//.test(file) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)

const allowed = (file: string) =>
  [...PACKAGE_A, ...WAITING, ...HISTORY].some((entry) =>
    entry.endsWith("/") ? file.startsWith(entry) : file === entry,
  )

function tracked(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  expect(out.exitCode).toBe(0)
  return out.stdout.toString().split("\0").filter(Boolean)
}

describe("no host of Nik", () => {
  test("no tracked source names nikcli-ai.dev or nikcli.store, but the listed leftovers", () => {
    const hits = tracked()
      .filter((file) => !OUT_OF_SCOPE(file) && !allowed(file))
      .filter((file) => {
        const full = path.join(ROOT, file)
        return fs.existsSync(full) && fs.statSync(full).isFile() && NIK.test(fs.readFileSync(full, "latin1"))
      })
    expect(hits).toEqual([])
  })
})
