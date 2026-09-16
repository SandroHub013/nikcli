import { ConnectorAuth } from "../auth"
import { Effect, Schema } from "effect"
import { runPromiseWithLayer } from "@/effect"

export class GithubApiError extends Schema.TaggedError<GithubApiError>()("GithubApiError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

function connectorAuthGet(name: string) {
  return runPromiseWithLayer(
    ConnectorAuth.defaultLayer,
    Effect.gen(function* () {
      const auth = yield* ConnectorAuth.Service
      return yield* auth.get(name)
    }),
  )
}

const GITHUB_API_BASE = "https://api.github.com"

export namespace GithubApi {
  export async function getRepo(token: string, owner: string, repo: string): Promise<any> {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    })
    if (!response.ok) {
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} ${response.statusText}`,
        status: response.status,
      })
    }
    return response.json()
  }

  export async function getRepoContent(
    token: string,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<any> {
    const url = ref
      ? `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`
      : `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${path}`
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    })
    if (!response.ok) {
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} ${response.statusText}`,
        status: response.status,
      })
    }
    return response.json()
  }

  export async function createIssue(
    token: string,
    owner: string,
    repo: string,
    title: string,
    body?: string,
  ): Promise<any> {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, body }),
    })
    if (!response.ok) {
      const error = await response.text()
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} - ${error}`,
        status: response.status,
      })
    }
    return response.json()
  }

  export async function getIssue(token: string, owner: string, repo: string, issueNumber: number): Promise<any> {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    })
    if (!response.ok) {
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} ${response.statusText}`,
        status: response.status,
      })
    }
    return response.json()
  }

  export async function listIssues(
    token: string,
    owner: string,
    repo: string,
    state: "open" | "closed" | "all" = "open",
  ): Promise<any> {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues?state=${state}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    })
    if (!response.ok) {
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} ${response.statusText}`,
        status: response.status,
      })
    }
    return response.json()
  }

  export async function searchCode(token: string, query: string, sort?: string, order?: "asc" | "desc"): Promise<any> {
    let url = `${GITHUB_API_BASE}/search/code?q=${encodeURIComponent(query)}`
    if (sort) url += `&sort=${sort}&order=${order}`
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    })
    if (!response.ok) {
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} ${response.statusText}`,
        status: response.status,
      })
    }
    return response.json()
  }

  export async function searchRepos(
    token: string,
    query: string,
    sort?: "stars" | "updated" | "help-wanted-issues",
  ): Promise<any> {
    let url = `${GITHUB_API_BASE}/search/repositories?q=${encodeURIComponent(query)}`
    if (sort) url += `&sort=${sort}`
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    })
    if (!response.ok) {
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} ${response.statusText}`,
        status: response.status,
      })
    }
    return response.json()
  }

  export async function getUser(token: string): Promise<any> {
    const response = await fetch(`${GITHUB_API_BASE}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    })
    if (!response.ok) {
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} ${response.statusText}`,
        status: response.status,
      })
    }
    return response.json()
  }

  export async function listRepos(
    token: string,
    type: "all" | "owner" | "member" = "owner",
    sort?: "updated" | "pushed" | "full_name",
  ): Promise<any> {
    // GitHub Apps and fine-grained PATs reject `type` (422). `affiliation` +
    // `visibility` cover the same filters and work for every token class.
    const affiliation =
      type === "owner"
        ? "owner"
        : type === "member"
          ? "collaborator,organization_member"
          : "owner,collaborator,organization_member"
    const params = new URLSearchParams({ affiliation, visibility: "all" })
    if (sort) params.set("sort", sort)
    const url = `${GITHUB_API_BASE}/user/repos?${params.toString()}`
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    })
    if (!response.ok) {
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} ${response.statusText}`,
        status: response.status,
      })
    }
    return response.json()
  }

  export async function listBranches(token: string, owner: string, repo: string): Promise<any> {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/branches?per_page=100`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    })
    if (!response.ok) {
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} ${response.statusText}`,
        status: response.status,
      })
    }
    return response.json()
  }

  export async function findPullRequestByHead(
    token: string,
    owner: string,
    repo: string,
    head: string,
    state: "open" | "closed" | "all" = "open",
  ): Promise<any | undefined> {
    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(head)}&state=${state}&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      },
    )
    if (!response.ok) {
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} ${response.statusText}`,
        status: response.status,
      })
    }
    // SAFETY: the non-ok branch above already returned, so this is the GitHub
    // pulls list body; the caller reads only the first element.
    const pulls = (await response.json()) as any[]
    return pulls[0]
  }

  export async function createPullRequest(
    token: string,
    owner: string,
    repo: string,
    title: string,
    head: string,
    base: string,
    body?: string,
  ): Promise<any> {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, head, base, body }),
    })
    if (!response.ok) {
      const error = await response.text()
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} - ${error}`,
        status: response.status,
      })
    }
    return response.json()
  }

  export async function getPullRequest(token: string, owner: string, repo: string, pullNumber: number): Promise<any> {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pullNumber}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    })
    if (!response.ok) {
      throw new GithubApiError({
        message: `GitHub API error: ${response.status} ${response.statusText}`,
        status: response.status,
      })
    }
    return response.json()
  }

  /**
   * Shared request path for the Actions endpoints below. The older functions in this file each
   * inline their own `fetch`; the Actions surface is six calls that differ only in method and
   * path, so they share one.
   */
  async function actionsRequest(
    token: string,
    path: string,
    init?: { method?: "GET" | "POST"; body?: unknown },
  ): Promise<any> {
    const response = await fetch(`${GITHUB_API_BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        ...(init?.body === undefined ? null : { "Content-Type": "application/json" }),
      },
      ...(init?.body === undefined ? null : { body: JSON.stringify(init.body) }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new GithubApiError({
        message: detail
          ? `GitHub API error: ${response.status} - ${detail.slice(0, 300)}`
          : `GitHub API error: ${response.status} ${response.statusText}`,
        status: response.status,
      })
    }
    // `POST /rerun` and `POST /cancel` answer 201/202 with an empty body.
    if (response.status === 204 || response.headers.get("content-length") === "0") return {}
    return response.json().catch(() => ({}))
  }

  export async function listWorkflows(token: string, owner: string, repo: string): Promise<any> {
    return actionsRequest(token, `/repos/${owner}/${repo}/actions/workflows?per_page=100`)
  }

  export async function listWorkflowRuns(
    token: string,
    owner: string,
    repo: string,
    options: { branch?: string; perPage?: number; event?: string } = {},
  ): Promise<any> {
    const params = new URLSearchParams({ per_page: String(Math.min(options.perPage ?? 20, 100)) })
    if (options.branch) params.set("branch", options.branch)
    if (options.event) params.set("event", options.event)
    // `exclude_pull_requests` keeps the payload small; nothing here renders the PR list.
    params.set("exclude_pull_requests", "true")
    return actionsRequest(token, `/repos/${owner}/${repo}/actions/runs?${params.toString()}`)
  }

  export async function listWorkflowRunJobs(token: string, owner: string, repo: string, runID: number): Promise<any> {
    return actionsRequest(token, `/repos/${owner}/${repo}/actions/runs/${runID}/jobs?per_page=100&filter=latest`)
  }

  export async function rerunWorkflowRun(
    token: string,
    owner: string,
    repo: string,
    runID: number,
    options: { failedOnly?: boolean } = {},
  ): Promise<any> {
    const path = options.failedOnly
      ? `/repos/${owner}/${repo}/actions/runs/${runID}/rerun-failed-jobs`
      : `/repos/${owner}/${repo}/actions/runs/${runID}/rerun`
    return actionsRequest(token, path, { method: "POST" })
  }

  export async function cancelWorkflowRun(token: string, owner: string, repo: string, runID: number): Promise<any> {
    return actionsRequest(token, `/repos/${owner}/${repo}/actions/runs/${runID}/cancel`, { method: "POST" })
  }

  export async function dispatchWorkflow(
    token: string,
    owner: string,
    repo: string,
    workflowID: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<any> {
    return actionsRequest(
      token,
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowID)}/dispatches`,
      {
        method: "POST",
        body: { ref, ...(inputs ? { inputs } : null) },
      },
    )
  }

  export async function getFileContent(token: string, owner: string, repo: string, path: string): Promise<string> {
    const content = await getRepoContent(token, owner, repo, path)
    if (content.encoding === "base64" && content.content) {
      return Buffer.from(content.content, "base64").toString("utf-8")
    }
    throw new GithubApiError({ message: "Unable to decode file content" })
  }
}

export async function getToken(name: string): Promise<string | null> {
  const auth = await connectorAuthGet(name)
  return auth?.token ?? null
}
