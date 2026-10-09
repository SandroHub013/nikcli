import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C (Master's decision after the first round): six more packages ran only Nik's
 * services and nothing imports them. `web` was the site and docs at nikcli-ai.dev (with its copies of the installers
 * and the docs-update workflow that wrote into it), `identity` the issuer at auth.nikcli-ai.dev, `inference` and
 * `inference-dashboard` the gateway at inference.nikcli-ai.dev and its dashboard, `cloud` and `enterprise` the
 * Cloudflare backend and the enterprise app. They go, with every reference in the workspace, the images and the CI.
 */
const ROOT = path.join(import.meta.dir, "../../../..")
const exists = (file: string) => fs.existsSync(path.join(ROOT, file))
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")
const NAMES =
  /packages\/(web|identity|inference|inference-dashboard|cloud|enterprise)\b|@ragu\/(web|identity|inference|inference-dashboard|cloud|enterprise)\b/

describe("Nik's backends and site are gone", () => {
  test("the packages and the workflow that wrote the site's docs are removed", () => {
    for (const file of [
      "packages/web",
      "packages/identity",
      "packages/inference",
      "packages/inference-dashboard",
      "packages/cloud",
      "packages/enterprise",
      ".github/workflows/docs-update.yml",
    ])
      expect([file, exists(file)]).toEqual([file, false])
  })

  test("the root scripts, the images, the CI and the tooling no longer name them", () => {
    const scripts = JSON.parse(read("package.json")).scripts
    expect(Object.values(scripts).filter((cmd) => /packages\/web\b/.test(String(cmd)))).toEqual([])
    for (const file of [
      "Dockerfile",
      "Dockerfile.serve",
      "packages/discord/Dockerfile",
      ".github/CODEOWNERS",
      ".railwayignore",
      ".prettierignore",
      "script/publish-start.ts",
      "packages/bench-tui/src/ragu-intel.ts",
      ".github/instructions/memory.instruction.md",
      "README.md",
    ])
      expect([file, NAMES.test(read(file))]).toEqual([file, false])
  })
})
