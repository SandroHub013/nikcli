import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mobile-actions-route-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_TEST_MODE = "1"
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_TEST_MODE",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])
for (const dir of ["data", "cache", "config", "state"]) {
  await fs.mkdir(path.join(testHome, dir), { recursive: true })
}

const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mobile-actions-route-project-")))
const { Instance } = await import("@/project/instance")
const { Server } = await import("@/server/server")

const originalFetch = globalThis.fetch
let githubCalls: Array<{ url: string; method: string }> = []

function request(pathname: string, init?: RequestInit) {
  return Server.fetch(
    new Request(`http://nikcli.local/mobile${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-nikcli-directory": projectDir,
        ...init?.headers,
      },
    }),
  )
}

/** Answers every `api.github.com` call from `routes`; anything unmatched is a 404 the test sees. */
function stubGithub(routes: Array<{ match: string; status?: number; body?: unknown }>) {
  githubCalls = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes("api.github.com")) return originalFetch(input as Parameters<typeof fetch>[0], init)
    githubCalls.push({ url, method: init?.method ?? "GET" })
    const route = routes.find((entry) => url.includes(entry.match))
    if (!route) return new Response(JSON.stringify({ message: "not stubbed" }), { status: 404 })
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

const completedRun = {
  id: 501,
  name: "CI",
  display_title: "",
  workflow_id: 9,
  run_number: 42,
  run_attempt: 1,
  status: "completed",
  conclusion: "failure",
  event: "push",
  head_branch: "feature/actions",
  head_sha: "abcdef1234567890",
  html_url: "https://github.com/acme/widget/actions/runs/501",
  created_at: "2026-01-01T10:00:00Z",
  run_started_at: "2026-01-01T10:00:10Z",
  updated_at: "2026-01-01T10:02:10Z",
  actor: { login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/1" },
  head_commit: { message: "fix: the thing\n\nlonger body" },
}

const liveRun = {
  id: 502,
  name: "Deploy",
  workflow_id: 10,
  run_number: 7,
  status: "in_progress",
  conclusion: null,
  event: "workflow_dispatch",
  head_branch: "feature/actions",
  head_sha: "1234567abcdef",
  html_url: "https://github.com/acme/widget/actions/runs/502",
  created_at: "2026-01-01T11:00:00Z",
  run_started_at: "2026-01-01T11:00:00Z",
  updated_at: "2026-01-01T11:00:30Z",
  head_commit: { message: "chore: deploy" },
}

afterEach(() => {
  globalThis.fetch = originalFetch
  githubCalls = []
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  await Instance.disposeAll().catch(() => undefined)
  await removeTestDir(testHome)
  await removeTestDir(projectDir)
})

describe("mobile GitHub Actions routes", () => {
  // Ordered: the unauthenticated check has to run before the token this file's other tests need.
  it("requires a GitHub token, then accepts one", async () => {
    const response = await request("/github/repos/acme/widget/actions/runs")
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: string }).error).toContain("GitHub token not configured")

    const saved = await request("/github/auth", { method: "POST", body: JSON.stringify({ token: "gho_test_token" }) })
    expect(saved.status).toBe(200)
  })

  it("normalizes workflow runs and keeps absent optional fields absent", async () => {
    stubGithub([{ match: "/actions/runs", body: { workflow_runs: [completedRun, liveRun], total_count: 2 } }])

    const response = await request("/github/repos/acme/widget/actions/runs?branch=feature%2Factions&limit=5")
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      runs: Array<Record<string, unknown>>
      totalCount: number
      configured: boolean
    }

    expect(body.totalCount).toBe(2)
    expect(body.configured).toBe(true)
    expect(githubCalls[0]?.url).toContain("branch=feature%2Factions")
    expect(githubCalls[0]?.url).toContain("per_page=5")
    // A repo with runs never needs the extra workflows call.
    expect(githubCalls).toHaveLength(1)

    const [failed, running] = body.runs
    // `display_title` is empty, so the title falls back to the commit subject only.
    expect(failed?.title).toBe("fix: the thing")
    expect(failed?.conclusion).toBe("failure")
    expect(failed?.durationMs).toBe(120_000)
    expect((failed?.actor as { login: string } | undefined)?.login).toBe("octocat")

    // A run still going has no duration at all — not `null`, which would fail the encode.
    expect("durationMs" in (running ?? {})).toBe(false)
    expect("conclusion" in (running ?? {})).toBe(false)
    expect(running?.status).toBe("in_progress")
    expect(running?.title).toBe("chore: deploy")
  })

  it("separates 'no runs yet' from 'no workflows at all'", async () => {
    stubGithub([
      { match: "/actions/runs", body: { workflow_runs: [], total_count: 0 } },
      { match: "/actions/workflows", body: { workflows: [] } },
    ])
    const empty = await request("/github/repos/acme/widget/actions/runs")
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { configured: boolean }).configured).toBe(false)

    stubGithub([
      { match: "/actions/runs", body: { workflow_runs: [], total_count: 0 } },
      { match: "/actions/workflows", body: { workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml" }] } },
    ])
    const configured = await request("/github/repos/acme/widget/actions/runs")
    expect(((await configured.json()) as { configured: boolean }).configured).toBe(true)
  })

  it("normalizes jobs with their step progress", async () => {
    stubGithub([
      {
        match: "/actions/runs/501/jobs",
        body: {
          jobs: [
            {
              id: 77,
              name: "build",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/acme/widget/runs/77",
              started_at: "2026-01-01T10:00:10Z",
              completed_at: "2026-01-01T10:01:10Z",
              steps: [
                { name: "checkout", number: 1, status: "completed", conclusion: "success" },
                { name: "test", number: 2, status: "in_progress", conclusion: null },
              ],
            },
          ],
        },
      },
    ])

    const response = await request("/github/repos/acme/widget/actions/runs/501/jobs")
    expect(response.status).toBe(200)
    const jobs = (await response.json()) as Array<Record<string, unknown>>
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.durationMs).toBe(60_000)
    const steps = jobs[0]?.steps as Array<Record<string, unknown>>
    expect(steps).toHaveLength(2)
    expect(steps[0]?.conclusion).toBe("success")
    expect("conclusion" in (steps[1] ?? {})).toBe(false)
  })

  it("routes re-run, re-run-failed and cancel to the right GitHub endpoints", async () => {
    stubGithub([{ match: "/actions/runs/501/rerun", status: 201 }])
    const rerun = await request("/github/repos/acme/widget/actions/runs/501/rerun", {
      method: "POST",
      body: JSON.stringify({ failedOnly: false }),
    })
    expect(rerun.status).toBe(200)
    expect(githubCalls[0]?.method).toBe("POST")
    expect(githubCalls[0]?.url).toEndWith("/actions/runs/501/rerun")

    stubGithub([{ match: "/actions/runs/501/rerun-failed-jobs", status: 201 }])
    const rerunFailed = await request("/github/repos/acme/widget/actions/runs/501/rerun", {
      method: "POST",
      body: JSON.stringify({ failedOnly: true }),
    })
    expect(rerunFailed.status).toBe(200)
    expect(githubCalls[0]?.url).toEndWith("/actions/runs/501/rerun-failed-jobs")

    stubGithub([{ match: "/actions/runs/502/cancel", status: 202 }])
    const cancel = await request("/github/repos/acme/widget/actions/runs/502/cancel", { method: "POST" })
    expect(cancel.status).toBe(200)
    expect(githubCalls[0]?.url).toEndWith("/actions/runs/502/cancel")
  })

  it("maps GitHub failures onto the mobile error contract", async () => {
    stubGithub([{ match: "/actions/runs", status: 403, body: { message: "Resource not accessible" } }])
    const forbidden = await request("/github/repos/acme/widget/actions/runs")
    expect(forbidden.status).toBe(401)
    expect(((await forbidden.json()) as { name: string }).name).toBe("Unauthorized")

    stubGithub([{ match: "/actions/runs/501/cancel", status: 409, body: { message: "Conflict" } }])
    const conflict = await request("/github/repos/acme/widget/actions/runs/501/cancel", { method: "POST" })
    expect(conflict.status).toBe(400)
    expect(((await conflict.json()) as { name: string }).name).toBe("BadRequest")
  })
})
