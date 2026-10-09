import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C: the packages that only ran Nik's hosted services go, with the SST stack that
 * deployed them. `slack` was the Slack app at slack.nikcli-ai.dev (and the `ragu-agent` workflow it dispatched to),
 * `function` the API at api.nikcli-ai.dev / api.nikcli.store, `console` the enterprise console, and `sst.config.ts`
 * with `infra/` deployed them on Nik's Cloudflare, Stripe and Supabase accounts. Nothing that stays imports them.
 */
const ROOT = path.join(import.meta.dir, "../../../..")
const exists = (file: string) => fs.existsSync(path.join(ROOT, file))
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")

describe("Nik's hosted-service packages are gone", () => {
  test("the packages, the SST stack and their workflows are removed", () => {
    for (const file of [
      "packages/slack",
      "packages/function",
      "packages/console",
      "sst.config.ts",
      "infra",
      ".github/workflows/deploy.yml",
      ".github/workflows/ragu-agent.yml",
      "script/run-headless.ts",
    ])
      expect([file, exists(file)]).toEqual([file, false])
  })

  test("the workspace, the root dependencies and the images no longer name them", () => {
    const pkg = JSON.parse(read("package.json"))
    expect(pkg.workspaces.packages).not.toContain("packages/console/*")
    expect(pkg.workspaces.packages).not.toContain("packages/slack")
    expect(pkg.devDependencies.sst).toBeUndefined()
    expect(pkg.dependencies["@slack/bolt"]).toBeUndefined()
    for (const file of ["Dockerfile", "Dockerfile.serve", ".github/CODEOWNERS", ".railwayignore"])
      expect([file, /packages\/(slack|function|console)\b|@ragu\/(slack|function|console-)/.test(read(file))]).toEqual([
        file,
        false,
      ])
  })
})
