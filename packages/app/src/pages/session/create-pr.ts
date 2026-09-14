/**
 * The pure half of the pull request dialog.
 *
 * Kept out of the component file so the tests can exercise it without importing
 * a module that pulls in solid-js/web, which resolves to the server build under
 * `bun test` and fails on an export the DOM build has.
 */

export type Repo = {
  owner: string
  repo: string
  fullName: string
  defaultBranch: string
  htmlUrl?: string
  private?: boolean
}

export type Branch = { name: string }

/** models the loose shape the repos endpoint returns without over-claiming it. */
export function toRepo(value: unknown): Repo | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, any>
  const owner = record.owner?.login ?? record.owner ?? record.ownerLogin
  const repo = record.name ?? record.repo
  if (typeof owner !== "string" || typeof repo !== "string") return undefined
  return {
    owner,
    repo,
    fullName: typeof record.full_name === "string" ? record.full_name : `${owner}/${repo}`,
    defaultBranch: record.default_branch ?? record.defaultBranch ?? "main",
    htmlUrl: record.html_url ?? record.htmlUrl,
    private: record.private,
  }
}

export function compareUrl(input: {
  repo: Repo
  base: string
  head: string
  title: string
  body: string
  draft: boolean
}) {
  const url = new URL(`https://github.com/${input.repo.owner}/${input.repo.repo}/compare/`)
  url.pathname += `${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`
  url.searchParams.set("expand", "1")
  if (input.title) url.searchParams.set("title", input.title)
  if (input.body) url.searchParams.set("body", input.body)
  if (input.draft) url.searchParams.set("draft", "1")
  return url.toString()
}

export type CreatedPR = {
  number: number
  html_url: string
  title?: string
  url?: string
}

export type CreatePRParams = {
  connected: boolean
  repo: Repo
  base: string
  head: string
  title: string
  body: string
  draft: boolean
  createApi?: (input: {
    owner: string
    repo: string
    title: string
    head: string
    base: string
    body?: string
    draft?: boolean
  }) => Promise<CreatedPR>
}

export type CreatePRResult =
  | { type: "created"; pr: CreatedPR }
  | { type: "compare"; url: string }

/**
 * Decides how to open a pull request: when a GitHub account is connected and an
 * API caller is available, creates it directly via the API. Otherwise, falls
 * back to the github.com/compare URL so the user can finish it in the browser.
 */
export async function createPullRequest(input: CreatePRParams): Promise<CreatePRResult> {
  if (input.connected && input.createApi) {
    const pr = await input.createApi({
      owner: input.repo.owner,
      repo: input.repo.repo,
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body || undefined,
      draft: input.draft,
    })
    return { type: "created", pr }
  }

  return {
    type: "compare",
    url: compareUrl(input),
  }
}

