import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { Flag } from "@ragu/util/flag"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const PACKAGE_ROOT = path.join(REPO_ROOT, "packages", "ragu")
const SCRIPT = path.join(PACKAGE_ROOT, "script", "check-flag-capture.ts")

describe("check-flag-capture.ts", () => {
  it("passes on the real flag.ts", () => {
    const result = spawnSync("bun", ["run", SCRIPT], { cwd: PACKAGE_ROOT, encoding: "utf8" })
    if (result.status !== 0) console.error(result.stdout, result.stderr)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("flag capture —")
  })
})

/**
 * The behaviour the gate protects, asserted directly.
 *
 * `Flag` is imported at the top of this file — before any of these cases set
 * anything — which is the ordering that was broken: a captured constant is
 * fixed by whichever module in the process touched a flag first, and under
 * `bun test` that is never the file that meant to set it.
 */
describe("flags that tests set are read at access", () => {
  function withEnv(name: string, value: string | undefined, body: () => void) {
    const saved = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    try {
      body()
    } finally {
      if (saved === undefined) delete process.env[name]
      else process.env[name] = saved
    }
  }

  it("requireOauth follows RAGU_REQUIRE_OAUTH set after import", () => {
    withEnv("RAGU_REQUIRE_OAUTH", "1", () => expect(Flag.requireOauth()).toBe(true))
    withEnv("RAGU_REQUIRE_OAUTH", undefined, () => expect(Flag.requireOauth()).toBe(false))
  })

  it("legacyLogin follows RAGU_LEGACY_LOGIN set after import", () => {
    // Moves with requireOauth on purpose: every call site reads both, and a
    // pair where one side is live and the other a snapshot can disagree.
    withEnv("RAGU_LEGACY_LOGIN", "true", () => expect(Flag.legacyLogin()).toBe(true))
    withEnv("RAGU_LEGACY_LOGIN", undefined, () => expect(Flag.legacyLogin()).toBe(false))
  })

  it("disableModelsFetch follows RAGU_DISABLE_MODELS_FETCH set after import", () => {
    withEnv("RAGU_DISABLE_MODELS_FETCH", "1", () => expect(Flag.disableModelsFetch()).toBe(true))
    withEnv("RAGU_DISABLE_MODELS_FETCH", undefined, () => expect(Flag.disableModelsFetch()).toBe(false))
  })

  it("disableFilewatcher follows RAGU_EXPERIMENTAL_DISABLE_FILEWATCHER set after import", () => {
    withEnv("RAGU_EXPERIMENTAL_DISABLE_FILEWATCHER", "1", () => expect(Flag.disableFilewatcher()).toBe(true))
    withEnv("RAGU_EXPERIMENTAL_DISABLE_FILEWATCHER", undefined, () => expect(Flag.disableFilewatcher()).toBe(false))
  })

  it("only 'true' and '1' are truthy, so an explicit 'false' closes the gate", () => {
    withEnv("RAGU_REQUIRE_OAUTH", "false", () => expect(Flag.requireOauth()).toBe(false))
    withEnv("RAGU_REQUIRE_OAUTH", "0", () => expect(Flag.requireOauth()).toBe(false))
    withEnv("RAGU_REQUIRE_OAUTH", "TRUE", () => expect(Flag.requireOauth()).toBe(true))
  })
})
