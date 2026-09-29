import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * `build.rs` bundles NikVerse's 3D city with bun. If it cannot, it warns and the app ships with the plain list,
 * unless `NIKVERSE_WORLD_REQUIRED` is set. A release that comes out without the city, in silence, is what these
 * hold off: every workflow that builds the app with `tauri build` sets the variable, on the job, and none turns
 * the bundling off.
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

/** Every workflow that builds the app: its jobs that run `tauri build`. */
const builds = readdirSync(WORKFLOWS)
  .filter((file) => /\.ya?ml$/.test(file))
  .flatMap((file) => {
    const text = readFileSync(join(WORKFLOWS, file), "utf8")
    return [...jobsOf(text)].filter(([, job]) => /\btauri build\b/.test(job)).map(([name, job]) => ({ file, name, job }))
  })
  .filter(({ job }) => /packages\/ade|working-directory:\s*packages\/ade/.test(job))

describe("the workflows that build ADE", () => {
  test("there are the release and the macOS build, and the job parser finds them", () => {
    expect(builds.map(({ file, name }) => `${file}:${name}`).sort()).toEqual(["ade-macos.yml:build", "ade-release.yml:build"])
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
