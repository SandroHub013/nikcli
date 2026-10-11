import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/*
 * `script/release-plan.ts` against a real git history: nikcli/nikcli commits that feat/ade
 * merged in (`release: v1.4xx.0`, `Revert "…"`) are not ADE's, so neither `check` nor `notes`
 * may see them; a commit of ours with a bad subject still has to fail.
 *
 * The repository is a throwaway one under the temp folder; the script runs in it as a child
 * process, with `RELEASE_UPSTREAM_BASES` pointing at a list the test writes.
 */

const SCRIPT = join(import.meta.dir, "..", "..", "script", "release-plan.ts")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Repo = { dir: string; git: (...args: string[]) => string; commit: (subject: string) => string }

function repo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "ade-release-plan-"))
  dirs.push(dir)
  let n = 0
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        ...args,
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    )
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
    return result.stdout.toString().trim()
  }
  /** A commit that touches ADE, so the script looks at it. */
  const commit = (subject: string) => {
    const file = join(dir, "packages", "ade", `file-${n++}.txt`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${subject}\n`)
    git("add", "--", ".")
    git("commit", "-q", "-m", subject)
    return git("rev-parse", "HEAD")
  }
  git("init", "-q", "-b", "main")
  return { dir, git, commit }
}

function run(r: Repo, bases: string[] | undefined, ...args: string[]) {
  let file = join(r.dir, "no-such-file.txt")
  if (bases) {
    file = join(r.dir, "upstream-bases.txt")
    writeFileSync(file, `${bases.join("\n")}\n`)
  }
  const env: Record<string, string | undefined> = { ...process.env, RELEASE_UPSTREAM_BASES: file }
  delete env.GITHUB_OUTPUT
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    cwd: r.dir,
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

/**
 * main: base ── ours ──────────── merge ── (HEAD)
 *           └─ upstream (Nik) ──┘
 * The merge commit is ours; `upstream` is the tip of Nik's side.
 */
function mergedUpstream(upstreamSubject: string) {
  const r = repo()
  const base = r.commit("feat(ade): the base")
  r.git("checkout", "-q", "-b", "upstream")
  const upstream = r.commit(upstreamSubject)
  r.git("checkout", "-q", "main")
  r.commit("feat(ade): ours")
  r.git("merge", "-q", "--no-ff", "-m", "merge: nikcli/nikcli v9", "upstream")
  return { r, base, upstream }
}

describe("release-plan script, upstream commits", () => {
  test("without the list, an upstream commit with a bad subject fails the check", () => {
    const { r, base, upstream } = mergedUpstream("release: v9.0.0")
    const result = run(r, undefined, "check", `${base}..HEAD`)
    expect(result.code).toBe(1)
    expect(result.err).toContain(upstream.slice(0, 10))
  })

  test("an upstream commit with a bad subject, merged into our branch, does not fail the check", () => {
    const { r, base, upstream } = mergedUpstream("release: v9.0.0")
    const result = run(r, [`${upstream}  # nikcli/nikcli v9.0.0`], "check", `${base}..HEAD`)
    expect(result.err).toBe("")
    expect(result.out).toContain("commit subjects ok")
    expect(result.code).toBe(0)
  })

  test("and it does not enter the notes, while our own commit does", () => {
    const { r, base, upstream } = mergedUpstream("fix(ade): a fix that is Nik's")
    const without = run(r, undefined, "notes", base, "HEAD")
    expect(without.out).toContain("a fix that is Nik's")
    const result = run(r, [upstream], "notes", base, "HEAD")
    expect(result.code).toBe(0)
    expect(result.out).not.toContain("a fix that is Nik's")
    expect(result.out).toContain("ours")
  })

  test("a commit of ours with a bad subject still fails the check", () => {
    const { r, base, upstream } = mergedUpstream("release: v9.0.0")
    const bad = r.commit("did some things")
    const result = run(r, [upstream], "check", `${base}..HEAD`)
    expect(result.code).toBe(1)
    expect(result.err).toContain(bad.slice(0, 10))
    expect(result.err).not.toContain(upstream.slice(0, 10))
  })

  test("a sha the clone does not have, a comment and a blank line are ignored", () => {
    const { r, base, upstream } = mergedUpstream("release: v9.0.0")
    const missing = "0123456789abcdef0123456789abcdef01234567"
    const list = ["# a comment", "", `${missing}  # not fetched in a shallow clone`, "not a sha", upstream]
    const result = run(r, list, "check", `${base}..HEAD`)
    expect(result.err).toBe("")
    expect(result.out).toContain("commit subjects ok")
    expect(result.code).toBe(0)
  })

  test("a list with only a missing sha leaves the range as it was", () => {
    const { r, base, upstream } = mergedUpstream("release: v9.0.0")
    const result = run(r, ["0123456789abcdef0123456789abcdef01234567"], "check", `${base}..HEAD`)
    expect(result.code).toBe(1)
    expect(result.err).toContain(upstream.slice(0, 10))
  })
})

/*
 * Full review 2026-10-06, ui 5: the tag is pushed before the release is built. A tag whose release was
 * never published must not be the base of the next plan, or the commits of the lost release are never
 * released.
 */
describe("release-plan script, tags without a public release", () => {
  /** main: feat ── tag ade-v0.1.0 (published) ── fix ── tag ade-v0.2.0 (build failed) ── HEAD */
  function lostRelease() {
    const r = repo()
    r.commit("feat(ade): first")
    r.git("tag", "-a", "ade-v0.1.0", "-m", "ADE 0.1.0")
    r.commit("fix(ade): the fix that was lost")
    r.git("tag", "-a", "ade-v0.2.0", "-m", "ADE 0.2.0")
    return r
  }
  const publishedList = (r: Repo, tags: string[]) => {
    const file = join(r.dir, "published.txt")
    writeFileSync(file, `${tags.join("\n")}\n`)
    return file
  }

  test("without the list, the newest tag is the base, as before: nothing to release", () => {
    const result = run(lostRelease(), undefined, "plan")
    expect(result.out).toContain("release=false")
    expect(result.out).toContain("since ade-v0.2.0")
  })

  test("with the public tags, the lost release's commits are planned again", () => {
    const r = lostRelease()
    const result = run(r, undefined, "plan", "--published-tags", publishedList(r, ["ade-v0.1.0"]))
    expect(result.code).toBe(0)
    expect(result.out).toContain("release=true")
    expect(result.out).toContain("since ade-v0.1.0")
    expect(result.out).toContain("the fix that was lost")
  })

  test("when the newest tag is public too, it is still the base", () => {
    const r = lostRelease()
    const result = run(r, undefined, "plan", "--published-tags", publishedList(r, ["ade-v0.1.0", "ade-v0.2.0"]))
    expect(result.out).toContain("release=false")
    expect(result.out).toContain("since ade-v0.2.0")
  })

  test("with no public tag at all, the plan starts from the beginning", () => {
    const r = lostRelease()
    const result = run(r, undefined, "plan", "--published-tags", publishedList(r, []))
    expect(result.out).toContain("release=true")
    expect(result.out).toContain("since the beginning")
  })

  test("a list that is not there is refused, never read as every tag", () => {
    const r = lostRelease()
    const result = run(r, undefined, "plan", "--published-tags", join(r.dir, "missing.txt"))
    expect(result.code).toBe(2)
    expect(result.err).toContain("--published-tags")
  })
})
