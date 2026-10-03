import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * `build.rs` bundles NikVerse's 3D city with bun. If it cannot, it warns and the app ships with the plain list,
 * unless `NIKVERSE_WORLD_REQUIRED` is set. A release that comes out without the city, in silence, is what these
 * hold off: every workflow that builds the app with `tauri build` and ships what it builds sets the variable, on
 * the job, and none turns the bundling off.
 */

const WORKFLOWS = join(import.meta.dir, "..", "..", "..", "..", ".github", "workflows")

/** The jobs of a workflow file, by name, each as its own text: a job starts at two spaces of indent under `jobs:`. */
function jobsOf(text: string): Map<string, string> {
  const start = text.search(/^jobs:\s*$/m)
  if (start < 0) return new Map()
  const lines = text.slice(start).split("\n").slice(1)
  const jobs = new Map<string, string>()
  let name: string | undefined
  for (const line of lines) {
    const head = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (head) {
      name = head[1]
      jobs.set(name, "")
    } else if (name) jobs.set(name, `${jobs.get(name)}${line}\n`)
  }
  return jobs
}

/** The `env:` block of a job itself (four spaces of indent), not the ones of its steps (eight). */
function jobEnv(job: string): string {
  const match = /^ {4}env:\s*\n((?: {6,}.*\n|\s*\n)*)/m.exec(job)
  return match ? match[1] : ""
}

/**
 * Whether a job hands what it builds to anyone: it uploads an artifact or a release asset, or publishes with the Tauri action. A job that
 * builds the app only to run it on a runner (the uninstaller's proof) ships nothing, so a city missing from it costs no one a release.
 */
export function shipsWhatItBuilds(job: string): boolean {
  return /actions\/upload-artifact|gh release (create|upload|edit)|tauri-apps\/tauri-action|upload-release-asset/.test(job)
}

/** Every workflow that builds the app: its jobs that run `tauri build`. */
const built = readdirSync(WORKFLOWS)
  .filter((file) => /\.ya?ml$/.test(file))
  .flatMap((file) => {
    const text = readFileSync(join(WORKFLOWS, file), "utf8")
    return [...jobsOf(text)].filter(([, job]) => /\btauri build\b/.test(job)).map(([name, job]) => ({ file, name, job }))
  })
  .filter(({ job }) => /packages\/ade|working-directory:\s*packages\/ade/.test(job))
/** The ones that ship what they build: the city has to be required in these. */
const builds = built.filter(({ job }) => shipsWhatItBuilds(job))

describe("the workflows that build ADE", () => {
  test("there are the release and the macOS build, and the job parser finds them", () => {
    expect(builds.map(({ file, name }) => `${file}:${name}`).sort()).toEqual(["ade-macos.yml:build", "ade-release.yml:build"])
  })

  test("what does not ship is the uninstaller's proof, and nothing else", () => {
    expect(built.filter(({ job }) => !shipsWhatItBuilds(job)).map(({ file, name }) => `${file}:${name}`)).toEqual([
      "ade-uninstall-check.yml:uninstall",
    ])
  })

  test("the criterion: an upload or a publish ships, a build that is only run does not", () => {
    expect(shipsWhatItBuilds("      - uses: actions/upload-artifact@v7\n")).toBe(true)
    expect(shipsWhatItBuilds('          gh release upload "$TAG" --clobber\n')).toBe(true)
    expect(shipsWhatItBuilds("        uses: tauri-apps/tauri-action@v0\n")).toBe(true)
    expect(shipsWhatItBuilds("          bun x tauri build --bundles nsis\n          ls -l src-tauri/target/release/bundle/nsis\n")).toBe(false)
    // Reading a release is not shipping into one.
    expect(shipsWhatItBuilds('          gh release view "$TAG" --json isDraft\n')).toBe(false)
  })

  test.each(builds.map((b) => [`${b.file}:${b.name}`, b.job] as const))("%s makes a missing 3D city fail the build", (_label, job) => {
    const env = jobEnv(job)
    expect(env).toMatch(/^\s*NIKVERSE_WORLD_REQUIRED:\s*"?1"?\s*$/m)
    // The line is a setting, not a comment that says so.
    expect(env.split("\n").filter((line) => line.includes("NIKVERSE_WORLD_REQUIRED") && !line.trim().startsWith("#"))).toHaveLength(1)
  })

  test("no workflow turns the bundling of the city off", () => {
    for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
      const lines = readFileSync(join(WORKFLOWS, file), "utf8").split("\n")
      expect([file, lines.filter((line) => line.includes("NIKVERSE_SKIP_WORLD") && !line.trim().startsWith("#"))]).toEqual([file, []])
    }
  })

  test("build.rs reads the variable under the name the workflows set", () => {
    const rs = readFileSync(join(import.meta.dir, "..", "..", "src-tauri", "build.rs"), "utf8")
    expect(rs).toContain('env::var_os("NIKVERSE_WORLD_REQUIRED")')
  })
})
