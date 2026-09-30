import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * NikVerse's assets are fetched by the app from the release `ade-updater`, one asset per file named `nikverse-<sha256>`, and the release workflow
 * puts them there. These hold the two ends together: the address the app builds, and the step that makes the files exist at it before a release
 * is public, without which every first opening of the world would fail.
 */

const root = join(import.meta.dir, "..", "..", "..", "..")
const workflow = readFileSync(join(root, ".github", "workflows", "ade-release.yml"), "utf8")
const rust = readFileSync(join(root, "packages", "ade", "src-tauri", "src", "nikverse_assets.rs"), "utf8")

/** The text of one job of the workflow: from its name at two spaces of indent to the next job's. */
function job(name: string): string {
  const lines = workflow.split("\n")
  const start = lines.findIndex((line) => line === `  ${name}:`)
  expect(start).toBeGreaterThan(-1)
  const end = lines.findIndex((line, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line))
  return lines.slice(start, end < 0 ? undefined : end).join("\n")
}

/** The text of one step of a job (from its `- name:` to the next step). */
function step(text: string, name: string): string {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`)
  expect(start).toBeGreaterThan(-1)
  const end = lines.findIndex((line, i) => i > start && /^ {6}- /.test(line))
  return lines.slice(start, end < 0 ? undefined : end).join("\n")
}

describe("NikVerse's assets on the release", () => {
  test("the app asks for them where the workflow puts them: the release ade-updater, an asset named by the file's hash", () => {
    const base = /pub const BASE_URL: &str = "([^"]+)"/.exec(rust)?.[1]
    expect(base).toBe("https://github.com/SandroHub013/nikcli/releases/download/ade-updater/nikverse-")
    // The repository in the address is the one the workflow releases from, and the asset name is `nikverse-` and the hash.
    expect(workflow).toContain("github.repository == 'SandroHub013/nikcli'")
    const upload = step(job("build"), "NikVerse assets")
    expect(upload).toContain('ASSET="nikverse-$HASH"')
    expect(upload).toContain("gh release upload ade-updater")
  })

  test("the app fetches from the very release its updater reads: the address is the updater's endpoint, its file name swapped for the asset's", () => {
    const conf = JSON.parse(readFileSync(join(root, "packages", "ade", "src-tauri", "tauri.conf.json"), "utf8"))
    const endpoints: string[] = conf.plugins.updater.endpoints
    expect(endpoints.length).toBe(1)
    const endpoint = endpoints[0]
    expect(endpoint.endsWith("/latest.json")).toBe(true)
    const base = /pub const BASE_URL: &str = "([^"]+)"/.exec(rust)?.[1]
    expect(base).toBe(`${endpoint.slice(0, -"latest.json".length)}nikverse-`)
  })

  test("after the uploads the release is asked what it holds, and every hash of the manifest must be there or the job fails", () => {
    const upload = step(job("build"), "NikVerse assets")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
    const uploads = upload.indexOf("gh release upload ade-updater")
    const check = upload.indexOf('LIVE="$(names)"')
    expect(uploads).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(uploads)
    const after = upload.slice(check)
    // The same files the manifest lists, each by the name the app asks for.
    expect(after).toContain(`find "$DIR" -type f -not -path '*/.*'`)
    expect(after).toMatch(/grep -qx "nikverse-\$HASH"/)
    expect(after).toMatch(/not on ade-updater[^\n]*\n[^\n]*ABSENT/)
    expect(after).toMatch(/if \[ "\$ABSENT" != "0" \]; then[^\n]*exit 1; fi/)
  })

  test("they are uploaded by the build, before the release is made public, and a failed upload fails the job", () => {
    const build = job("build")
    const upload = step(build, "NikVerse assets")
    expect(upload).toContain("set -euo pipefail")
    // The failure is an exit: an upload that did not work and left no asset behind ends the step.
    expect(upload).toMatch(/could not upload[^\n]*exit 1/)
    // Public only in `publish`, which waits for every build.
    expect(build.indexOf("- name: NikVerse assets")).toBeLessThan(build.indexOf("- name: Collect and upload"))
    const publish = job("publish")
    expect(publish).toMatch(/needs:\s*build/)
    expect(publish).toContain("--draft=false")
    expect(publish).not.toContain("nikverse-$HASH")
    expect(build).not.toContain("--draft=false")
  })

  test("an asset is never replaced (no --clobber on it), and the same file twice is one asset", () => {
    // The commands, not the comments that explain them.
    const upload = step(job("build"), "NikVerse assets")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
    expect(upload).not.toContain("--clobber")
    // Skipped when it is already there, by its name.
    expect(upload).toMatch(/grep -qx "\$ASSET"/)
  })

  test("the release that holds them exists before the builds start, made once and not by builds that run side by side", () => {
    const draft = job("draft")
    expect(step(draft, "The updater release")).toContain("gh release create ade-updater")
    expect(step(job("build"), "NikVerse assets")).not.toContain("gh release create")
  })

  test("only the release run does it: attaching installers to an existing nikcli release leaves the updater feed alone", () => {
    expect(step(job("build"), "NikVerse assets")).toContain("if: ${{ !inputs.attach_only }}")
    expect(step(job("draft"), "The updater release")).toContain("if: ${{ !inputs.attach_only }}")
  })
})
