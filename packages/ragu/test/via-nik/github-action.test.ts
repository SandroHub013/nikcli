import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package B (5), the GitHub Action in github/: it traded the workflow's OIDC token
 * (or a PAT, in mock runs) for a token of Nik's GitHub App at api.nikcli-ai.dev. The exchange goes: the action uses
 * the workflow's GITHUB_TOKEN, or a token passed as the `github_token` input, as this repository's own workflows
 * already did. Nik's App, its install command and the OIDC permission leave the README.
 */
const ROOT = path.join(import.meta.dir, "../../../..")
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")

describe("the GitHub Action without Nik's App backend", () => {
  test("no token exchange with api.nikcli-ai.dev and no OIDC token", () => {
    const source = read("github/index.ts")
    expect(source).not.toContain("nikcli-ai.dev")
    expect(source).not.toContain("getIDToken")
    expect(source).not.toContain("revokeAppToken")
  })

  test("the token comes from the workflow, through one input", () => {
    const action = read("github/action.yml")
    expect(action).not.toMatch(/oidc_base_url|use_github_token/)
    expect(action).toMatch(/github_token:[\s\S]*?default: "\$\{\{ github\.token \}\}"/)
    expect(action).toContain("TOKEN: ${{ inputs.github_token }}")
  })

  test("the README sends nobody to Nik's App", () => {
    const readme = read("github/README.md")
    expect(readme).not.toMatch(/ragu github install|apps\/nikcli-agent|id-token: write|use_github_token/)
  })
})
