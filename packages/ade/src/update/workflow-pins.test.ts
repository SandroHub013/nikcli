import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/*
 * Full review 2026-10-06, ui 6: the release job that signs ran third-party actions on moving tags
 * (`@stable` is a branch, `@v2` moves), with the updater's private key in the environment of the build. A
 * compromised action could have changed the toolchain and had a tampered binary signed. Every `uses:` of an
 * ADE workflow or local action that is not in this repository is pinned to a commit.
 */
const ROOT = join(import.meta.dir, "..", "..", "..", "..")
const WORKFLOWS = join(ROOT, ".github", "workflows")
const ACTIONS = join(ROOT, ".github", "actions")

function adeFiles(): { name: string; text: string }[] {
  const workflows = readdirSync(WORKFLOWS)
    .filter((name) => /^ade-.*\.ya?ml$/.test(name))
    .map((name) => join(WORKFLOWS, name))
  const actions = readdirSync(ACTIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ACTIONS, entry.name, "action.yml"))
  return [...workflows, ...actions].map((name) => ({ name, text: readFileSync(name, "utf8") }))
}

/** Every `uses:` value of a file, with the line it is on. */
function uses(text: string): { line: number; value: string }[] {
  return text.split(/\r?\n/).flatMap((content, index) => {
    const match = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(content)
    return match ? [{ line: index + 1, value: match[1]! }] : []
  })
}

describe("third-party actions in the ADE workflows", () => {
  test("there are workflows to look at", () => {
    const names = adeFiles().map((file) => file.name)
    expect(names.some((name) => name.endsWith("ade-release.yml"))).toBe(true)
    expect(names.some((name) => name.endsWith("ade-auto-release.yml"))).toBe(true)
  })

  test("every one is pinned to a full commit sha, never a tag or a branch", () => {
    const loose: string[] = []
    for (const file of adeFiles()) {
      for (const { line, value } of uses(file.text)) {
        if (value.startsWith("./")) continue
        if (!/^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/.test(value)) loose.push(`${file.name}:${line} ${value}`)
      }
    }
    expect(loose).toEqual([])
  })

  test("the pin keeps its readable name in a comment", () => {
    const bare: string[] = []
    for (const file of adeFiles()) {
      const lines = file.text.split(/\r?\n/)
      for (const { line, value } of uses(file.text)) {
        if (!value.startsWith("./") && !/#\s*\S/.test(lines[line - 1]!)) bare.push(`${file.name}:${line} ${value}`)
      }
    }
    expect(bare).toEqual([])
  })
})

/*
 * Full review 2026-10-06, ui 5 and ui 7: the plan counts public releases only, and the feed is never moved
 * back. The scripts have their own tests; this is that the workflows still call them.
 */
describe("the release workflows keep their guards", () => {
  const read = (name: string) => readFileSync(join(WORKFLOWS, name), "utf8")

  test("the plan is given the public tags, and the draft's notes start from a public release", () => {
    expect(read("ade-auto-release.yml")).toContain("--published-tags published-tags.txt")
    expect(read("ade-auto-release.yml")).toContain("--exclude-drafts")
    expect(read("ade-release.yml")).toContain("grep -Fx -f published-tags.txt")
  })

  test("the tag step clears an unreleased tag of the same name and never a public one", () => {
    const text = read("ade-auto-release.yml")
    expect(text).toContain('git push origin ":refs/tags/$TAG"')
    expect(text).toContain('if [ "$STATE" = "false" ]')
  })

  /*
   * Verifiche's review of F4: an API error read as «no release» cleared a tag and left its draft; a pipe into
   * `grep -q` under pipefail read a SIGPIPE as «no feed» and wrote it unseen.
   */
  test("the tag step stops on an API error and takes only «release not found» for no release", () => {
    const text = read("ade-auto-release.yml")
    expect(text).not.toContain("|| echo none")
    expect(text).toContain("release not found")
    expect(text).toContain("exit 1")
  })

  test("the feed check reads the asset names into a variable, not through a pipe into grep -q", () => {
    const text = read("ade-release.yml")
    const at = text.indexOf("ade-updater feed")
    const step = text.slice(text.lastIndexOf("CURRENT=-", at), at)
    expect(step).toContain('ASSETS="$(gh release view ade-updater')
    expect(step).toContain('grep -qx latest.json <<<"$ASSETS"')
    expect(step).not.toMatch(/\|\s*grep\s+-\w*q/)
  })

  test("the updater feed is written only when the guard says so", () => {
    const text = read("ade-release.yml")
    expect(text).toContain("script/feed-guard.ts")
    // The publish job checks out only what it runs: the script and the rule it imports.
    expect(text).toContain("packages/ade/src/update/feed-guard.ts")
    // The only upload to the fixed release is inside the `write` branch.
    const uploads = text.split("\n").filter((line) => line.includes("release upload ade-updater latest.json"))
    expect(uploads.length).toBe(1)
    expect(uploads[0]).toContain("write)")
  })

  test("CONTRIBUTING does not say the scheduled release is off while the workflow has a schedule", () => {
    const workflow = read("ade-auto-release.yml")
    const guide = readFileSync(join(ROOT, "packages", "ade", "CONTRIBUTING.md"), "utf8")
    if (/^\s*schedule:/m.test(workflow)) expect(guide).not.toMatch(/ade-auto-release\.yml`? is \*\*disabled/)
  })
})
