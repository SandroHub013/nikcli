#!/usr/bin/env bun
/**
 * Git plumbing around `src/update/release-plan.ts`, for the ADE workflows.
 *
 *   bun packages/ade/script/release-plan.ts plan [--min-age-hours N] [--skip-shas FILE] [--major-shas FILE] [--published-tags FILE]
 *   bun packages/ade/script/release-plan.ts check <from>..<to>
 *   bun packages/ade/script/release-plan.ts notes <from> <to>
 *
 * `plan` looks at HEAD against the newest `ade-v*` tag and, in GitHub Actions,
 * writes `release`, `version`, `tag` and `reason` to `$GITHUB_OUTPUT` and the
 * notes to `release-notes.md`. The sha files list commits of pull requests
 * labelled `release:skip` or `release:major`, one per line.
 *
 * `check` fails when a commit in the range that touches ADE breaks the
 * subject format. `notes` prints the grouped notes for a range.
 *
 * None of the three sees a commit reachable from `release/upstream-bases.txt`:
 * those are nikcli/nikcli releases merged into feat/ade, Nik's commits, not ADE's.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  COMMIT_TYPES,
  SKIP_MARKER,
  invalidSubjects,
  planRelease,
  releaseNotes,
  type Commit,
} from "../src/update/release-plan"

/** What an ADE release is built from; the same list `ade-release.yml` uses for its notes. */
const RELEASE_PATHS = ["packages/ade", "packages/voice", "packages/plugin/src/v2/ade"]

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

/** Commits of nikcli/nikcli already merged into feat/ade; `RELEASE_UPSTREAM_BASES` overrides the file (tests). */
const UPSTREAM_BASES =
  process.env.RELEASE_UPSTREAM_BASES ?? join(import.meta.dir, "..", "release", "upstream-bases.txt")

/**
 * The upstream commits to leave out of every range. A sha this clone does not have is ignored:
 * a shallow clone, or one that never fetched upstream, must not break the check.
 */
function upstreamBases(): string[] {
  if (!existsSync(UPSTREAM_BASES)) return []
  return readFileSync(UPSTREAM_BASES, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter((sha) => /^[0-9a-f]{40}$/i.test(sha))
    .filter((sha) => {
      const probe = Bun.spawnSync(["git", "cat-file", "-e", `${sha}^{commit}`], { stdout: "ignore", stderr: "ignore" })
      return probe.exitCode === 0
    })
}

function commits(range: string): Commit[] {
  /* `--not` has to come before `--`, or git reads the shas as paths. */
  const bases = upstreamBases()
  const exclude = bases.length > 0 ? ["--not", ...bases] : []
  const out = git("log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", range, ...exclude, "--", ...RELEASE_PATHS)
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split("\x1f")
      return { sha, subject, body }
    })
}

/**
 * The newest `ade-v*` tag HEAD contains. With `published`, only a tag whose release is public counts.
 *
 * `ade-auto-release` pushes the tag before the release is built. A build that fails leaves the tag and a
 * draft: counted as the base, the next run saw «nothing to release» and the commits of the lost release
 * never went out (full review 2026-10-06, ui 5). The workflow passes the tags of the public releases.
 */
function lastTag(published?: ReadonlySet<string>): string | undefined {
  const tags = git("tag", "--list", "ade-v*", "--merged", "HEAD", "--sort=-v:refname").split("\n").filter(Boolean)
  return tags.find((tag) => !published || published.has(tag))
}

function shas(flag: string, argv: string[]): Set<string> {
  const index = argv.indexOf(flag)
  const file = index >= 0 ? argv[index + 1] : undefined
  if (!file || !existsSync(file)) return new Set()
  return new Set(readFileSync(file, "utf8").split(/\s+/).filter(Boolean))
}

function output(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(""),
    )
  }
}

function plan(argv: string[]) {
  // The flag given and the file missing is a refusal, not «every tag»: a workflow that could not list the
  // releases must not fall back to counting an unreleased tag.
  const publishedFlag = argv.indexOf("--published-tags")
  const publishedFile = publishedFlag >= 0 ? argv[publishedFlag + 1] : undefined
  if (publishedFlag >= 0 && (!publishedFile || !existsSync(publishedFile))) {
    console.error("--published-tags needs the file of public release tags")
    process.exit(2)
  }
  const published = publishedFile ? new Set(readFileSync(publishedFile, "utf8").split(/\s+/).filter(Boolean)) : undefined
  const last = lastTag(published)
  const skip = shas("--skip-shas", argv)
  const major = shas("--major-shas", argv)
  const list = commits(last ? `${last}..HEAD` : "HEAD").map((c) => ({
    ...c,
    body: [
      c.body,
      skip.has(c.sha) ? SKIP_MARKER : "",
      major.has(c.sha) ? "BREAKING CHANGE: labelled release:major" : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  }))

  const result = planRelease(last, list)
  if (!result) {
    output({ release: "false", reason: `nothing to release since ${last ?? "the beginning"}` })
    return
  }

  /* A release cut minutes after a push can catch a series of commits halfway:
     wait until the newest one has sat for a while. */
  const flag = argv.indexOf("--min-age-hours")
  const hours = flag >= 0 ? Number(argv[flag + 1]) : 0
  const newest = Number(git("log", "-1", "--format=%ct", "HEAD").trim()) * 1000
  const age = (Date.now() - newest) / 3_600_000
  if (age < hours) {
    output({ release: "false", reason: `newest commit is ${age.toFixed(1)}h old, waiting for ${hours}h` })
    return
  }

  if (process.env.GITHUB_OUTPUT) writeFileSync("release-notes.md", `${result.notes}\n`)
  else console.log(`\n${result.notes}\n`)
  output({
    release: "true",
    version: result.version,
    tag: `ade-v${result.version}`,
    reason: `${result.bump} since ${last ?? "the beginning"}`,
  })
}

function check(range: string | undefined) {
  if (!range) throw new Error("check needs a range, e.g. origin/feat/ade..HEAD")
  const bad = invalidSubjects(commits(range))
  if (bad.length === 0) {
    console.log("commit subjects ok")
    return
  }
  console.error(
    `These commits touch ADE and do not follow \`type(scope): description\` (types: ${COMMIT_TYPES.join(", ")}):`,
  )
  for (const c of bad) console.error(`  ${c.sha.slice(0, 10)} ${c.subject}`)
  console.error("See packages/ade/CONTRIBUTING.md.")
  process.exit(1)
}

const [command, ...rest] = process.argv.slice(2)
if (command === "plan") plan(rest)
else if (command === "check") check(rest[0])
else if (command === "notes" && rest[0] && rest[1]) console.log(releaseNotes(commits(`${rest[0]}..${rest[1]}`)))
else {
  console.error(
    "usage: release-plan.ts plan [--min-age-hours N] [--skip-shas FILE] [--major-shas FILE] [--published-tags FILE] | check <range> | notes <from> <to>",
  )
  process.exit(2)
}
