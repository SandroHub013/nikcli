#!/usr/bin/env bun

/**
 * ci-autofix.ts — Runs ragu headlessly to attempt validation repair.
 *
 * Safety guards:
 *   - Refuses to run on untrusted contexts (forks, bots, release/generated/autofix commits)
 *   - Anti-loop: skips commits with [ragu autofix], release: v, chore: generate, [skip ci]
 *   - Only pushes if validation passes after changes
 *   - Never touches version/release files unless explicitly required
 */

import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { delimiter, join } from "path"

// ─── Redaction ──────────────────────────────────────────────────────────────

const REDACT_PATTERNS = [
  /ghp_[A-Za-z0-9]{36,}/g,
  /gho_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /npm_[A-Za-z0-9]{36,}/g,
  /x-access-token:[A-Za-z0-9_-]+@/g,
]

function redact(text: string): string {
  for (const pattern of REDACT_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]")
  }
  return text
}

// ─── Anti-loop / trust guards ───────────────────────────────────────────────

const COMMIT_MSG = process.env.GITHUB_EVENT_HEAD_COMMIT_MESSAGE || ""
const COMMIT_MSG_PR = process.env.GITHUB_EVENT_PULL_REQUEST_TITLE || ""
const ACTOR = process.env.GITHUB_ACTOR || ""
const REPO = process.env.GITHUB_REPOSITORY || ""
const EVENT = process.env.GITHUB_EVENT_NAME || ""
const PR_HEAD_REPO = process.env.GITHUB_EVENT_PULL_REQUEST_HEAD_REPO_FULL_NAME || ""

// Commit messages that indicate we should NOT attempt autofix
const SKIP_PATTERNS = [/^\[ragu autofix\]/, /^release: v/, /^chore: generate/, /\[skip ci\]/]

function shouldSkip(): { skip: boolean; reason: string } {
  // Skip bot commits
  if (ACTOR === "github-actions[bot]" || ACTOR === "ragu-ci[bot]") {
    return { skip: true, reason: `Bot actor: ${ACTOR}` }
  }

  // Skip fork PRs
  if (EVENT === "pull_request" && PR_HEAD_REPO && PR_HEAD_REPO !== REPO) {
    return { skip: true, reason: `Fork PR: ${PR_HEAD_REPO} !== ${REPO}` }
  }

  // Skip known commit patterns
  const msg = COMMIT_MSG || COMMIT_MSG_PR
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(msg)) {
      return { skip: true, reason: `Skip pattern matched in: ${msg.slice(0, 80)}` }
    }
  }

  // Require API key for LLM access
  if (!process.env.MINIMAX_API_KEY) {
    return { skip: true, reason: "Missing MINIMAX_API_KEY secret" }
  }

  // Only run on the ragu repo (moved from nikomatt69/nikcli to nikcli/nikcli)
  if (REPO !== "nikomatt69/nikcli" && REPO !== "nikcli/nikcli") {
    return { skip: true, reason: `Wrong repository: ${REPO}` }
  }

  return { skip: false, reason: "" }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const guard = shouldSkip()
  if (guard.skip) {
    console.log(`⏭️  Autofix skipped: ${guard.reason}`)
    // Signal to the workflow that this was intentionally skipped (exit 0 but no changes)
    process.exit(0)
  }

  console.log("=== Ragu Autofix Started ===\n")

  // Step 1: Run validation to reproduce the failure
  console.log("▸ Running validation to reproduce failure...")
  const validateProc = Bun.spawn(["bun", "run", "script/ci-validate.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb", CI: "true" },
  })

  const validateExit = await validateProc.exited
  const validateStderr = await new Response(validateProc.stderr).text()

  if (validateExit === 0) {
    console.log("✅ Validation passed on rerun. No autofix needed.")
    process.exit(0)
  }

  console.log("❌ Validation failed as expected. Proceeding with autofix.\n")

  // Read the validation summary for context
  let summary = "(no summary available)"
  if (existsSync("tmp/ci-validation-summary.md")) {
    summary = readFileSync("tmp/ci-validation-summary.md", "utf8")
  }

  // Step 2: Install ragu
  console.log("▸ Installing ragu...")
  const installProc = Bun.spawn(["bash", "-c", "curl -fsSL https://nikcli-ai.dev/install | bash"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb" },
  })
  const installExit = await installProc.exited
  if (installExit !== 0) {
    const installErr = await new Response(installProc.stderr).text()
    console.error(`Failed to install ragu: ${redact(installErr).slice(-500)}`)
    process.exit(1)
  }
  console.log("✅ ragu installed")

  // The installer drops the binary in ~/.nikcli/bin and appends that to the shell profile —
  // which this already-running process never re-reads. Spawning "ragu" by name therefore
  // died with `Executable not found in $PATH` on every autofix run. Resolve the binary and
  // prepend its directory, so ragu and anything it shells out to both find it.
  const raguBinDir = join(homedir(), ".nikcli", "bin")
  const raguBin = join(raguBinDir, "ragu")
  if (!existsSync(raguBin)) {
    console.error(`ragu not found at ${raguBin} after install`)
    process.exit(1)
  }
  const raguPath = `${raguBinDir}${delimiter}${process.env.PATH ?? ""}`

  // Step 3: Run ragu headless repair
  const model = process.env.RAGU_AUTOFIX_MODEL || "minimax-coding-plan/MiniMax-M3"
  const prompt = [
    "Reproduce and fix the validation failure shown below.",
    "Make the SMALLEST possible change to fix the issue.",
    "Do NOT touch version files, release files, or package.json version fields.",
    "Do NOT add new dependencies unless absolutely required.",
    "After making changes, re-run: bun run script/ci-validate.ts",
    "If validation still fails after your fix, explain why.",
    "",
    "=== Validation Summary ===",
    summary.slice(0, 4000), // Limit context size
  ].join("\n")

  console.log(`▸ Running ragu autofix with model: ${model}`)

  const raguProc = Bun.spawn([raguBin, "run", "--command", prompt, "--model", model, "--format", "json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: raguPath,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
      TERM: "dumb",
      CI: "true",
    },
    cwd: process.cwd(),
  })

  const raguExit = await raguProc.exited
  const raguStdout = await new Response(raguProc.stdout).text()
  const raguStderr = await new Response(raguProc.stderr).text()

  console.log(`ragu exited with code ${raguExit}`)
  if (raguStderr.length > 0) {
    // Don't dump full stderr — just last few lines, redacted
    const tail = raguStderr.split("\n").slice(-5).join("\n")
    console.log(`ragu stderr (tail): ${redact(tail)}`)
  }

  // Step 4: Re-run validation after attempted fix
  console.log("\n▸ Running validation after autofix attempt...")
  const revalidateProc = Bun.spawn(["bun", "run", "script/ci-validate.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb", CI: "true" },
  })

  const revalidateExit = await revalidateProc.exited

  if (revalidateExit === 0) {
    console.log("✅ Validation passed after autofix!")

    // Check if there are actual changes
    const statusProc = Bun.spawn(["git", "status", "--porcelain"], {
      stdout: "pipe",
    })
    const status = await new Response(statusProc.stdout).text()
    await statusProc.exited

    if (status.trim().length === 0) {
      console.log("No file changes detected. Nothing to push.")
      process.exit(0)
    }

    // The workflow will handle git add/commit/push
    console.log("Changes detected. Ready for commit.")
    process.exit(0)
  }

  // Validation still fails after autofix
  console.log("❌ Validation still fails after autofix attempt.")
  console.log("The report-failure job will comment on the PR/issue.")

  // Exit with a distinct code (78) to signal: autofix attempted but failed
  // This is different from crash (1) or skip (0)
  process.exit(78)
}

main().catch((err) => {
  console.error("Autofix runner crashed:", String(err).slice(0, 200))
  process.exit(1)
})
