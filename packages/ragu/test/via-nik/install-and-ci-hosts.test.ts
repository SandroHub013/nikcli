import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C: the install scripts downloaded the binaries from nikcli-ai.dev first (GitHub
 * releases only as a fallback) and printed Nik's docs; the CI workflows and the autofix script installed the CLI by
 * piping nikcli-ai.dev/install into bash, the Linux test job committed as bot@nikcli-ai.dev, and web-version-check kept
 * Nik's live site in sync with the releases. The scripts now go to GitHub releases only, CI runs the repo's own
 * `install`, and the site workflow goes.
 */
const ROOT = path.join(import.meta.dir, "../../../..")
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")
const NIK = /nikcli-ai\.dev|nikcli\.store/

describe("install and CI without Nik's site", () => {
  test("the install scripts download from GitHub releases only", () => {
    for (const file of ["install", "install.ps1"]) {
      expect(read(file)).not.toMatch(NIK)
      expect(read(file)).toContain("https://github.com/")
    }
  })

  test("CI installs the CLI with the repo's own script", () => {
    for (const file of ["beta.yml", "duplicate-issues.yml", "review.yml", "triage.yml", "test.yml"]) {
      expect(read(path.join(".github", "workflows", file))).not.toMatch(NIK)
    }
    expect(read(".github/workflows/triage.yml")).toContain("bash ./install")
    expect(read("script/ci-autofix.ts")).not.toMatch(NIK)
    expect(read("script/ci-autofix.ts")).toContain(`["bash", "./install"]`)
  })

  test("the workflow that synced Nik's site is gone", () => {
    expect(fs.existsSync(path.join(ROOT, ".github/workflows/web-version-check.yml"))).toBe(false)
  })
})
