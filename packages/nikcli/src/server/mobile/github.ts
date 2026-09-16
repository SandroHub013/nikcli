import { Effect } from "effect"
import { ConnectorAuth } from "@/connectors/auth"
import { Connectors } from "@/connectors"
import { GithubApi, GithubApiError } from "@/connectors/api/github"
import { withInstanceAsync } from "@/effect"
import { MobileGithubRepo } from "@/mobile/github-repo"
import { spreadIf } from "@/util/optional-key"
import { Session } from "@/session"
import { Worktree } from "@/worktree"
import { Workspace } from "@/workspace"
import { WorkspaceContext } from "@/workspace/workspace-context"
import {
  GithubAuthInput,
  GithubOAuthClientInput,
  MobileGithubDeviceAuthPollInput,
  MobileGithubRerunInput,
  MobileGithubSessionCreateInput,
  MobileGithubWorkflowDispatchInput,
  configGet,
  createExecutionWorkspace,
  ensureGlobalGithubConnector,
  githubConnectorEntry,
  githubImports,
  githubToken,
  pollGithubDeviceAuth,
  runConnectorAuth,
  runSession,
  runWorktreeForDirectory,
  sessionSeed,
  slug,
  startGithubDeviceAuth,
  storeGithubToken,
} from "./helpers"
import { MobileHttpError } from "./request"

const noToken = () => new MobileHttpError("GitHub token not configured", 401)

function githubHttpError(error: GithubApiError): MobileHttpError {
  const status = error.status === 401 || error.status === 403 ? 401 : 400
  return new MobileHttpError(error.message, status)
}

export async function githubRepos() {
  const token = await githubToken()
  if (!token) throw noToken()
  try {
    const [repos, imports] = await Promise.all([GithubApi.listRepos(token, "all", "updated"), githubImports()])
    return (
      // SAFETY: `listRepos` returns the GitHub `/user/repos` body, whose every
      // element carries `full_name`; only that field is read here.
      //
      // Do not assign `imported_*` as `undefined`: `Schema.Unknown` is
      // `Schema.Json` at the HTTP boundary and a present `undefined` fails
      // encode with an empty 400 — the mobile Workspaces screen's
      // "Could not load GitHub repositories" banner.
      (repos as Array<{ full_name: string }>).map((repo) => {
        const existing = imports.get(repo.full_name.toLowerCase())
        return {
          ...repo,
          imported: Boolean(existing),
          ...spreadIf("imported_directory", existing?.directory),
          ...spreadIf("imported_project_id", existing?.projectID),
        }
      })
    )
  } catch (error) {
    if (error instanceof GithubApiError) throw githubHttpError(error)
    throw error
  }
}

export async function githubBranches(owner: string, repo: string) {
  const token = await githubToken()
  if (!token) throw noToken()
  try {
    return await GithubApi.listBranches(token, owner, repo)
  } catch (error) {
    if (error instanceof GithubApiError) throw githubHttpError(error)
    throw error
  }
}

/** ms timestamp from a GitHub ISO date, or `undefined` for null/absent/unparsable. */
function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function duration(startedAt: number | undefined, completedAt: number | undefined) {
  if (startedAt === undefined || completedAt === undefined) return undefined
  const elapsed = completedAt - startedAt
  return elapsed >= 0 ? elapsed : undefined
}

/** First line of a commit message — the run list shows one line per run. */
function firstLine(value: unknown) {
  return typeof value === "string" ? (value.split("\n")[0] ?? "").trim() : ""
}

type RawRun = {
  id: number
  name?: string | null
  display_title?: string | null
  workflow_id?: number
  run_number?: number
  run_attempt?: number
  status?: string | null
  conclusion?: string | null
  event?: string
  head_branch?: string | null
  head_sha?: string
  html_url?: string
  created_at?: string
  updated_at?: string
  run_started_at?: string
  actor?: { login?: string; avatar_url?: string } | null
  head_commit?: { message?: string } | null
}

function normalizeRun(raw: RawRun) {
  const createdAt = timestamp(raw.created_at) ?? Date.now()
  const updatedAt = timestamp(raw.updated_at) ?? createdAt
  const startedAt = timestamp(raw.run_started_at) ?? createdAt
  const status = raw.status ?? "queued"
  // A run that is still going has no end yet; its elapsed time is measured against now by the
  // client so the number keeps ticking without a refetch.
  const completedAt = status === "completed" ? updatedAt : undefined
  const title = firstLine(raw.display_title) || firstLine(raw.head_commit?.message) || (raw.name ?? "Workflow run")
  return {
    id: raw.id,
    name: raw.name ?? "Workflow",
    ...spreadIf("workflowID", raw.workflow_id),
    runNumber: raw.run_number ?? 0,
    ...spreadIf("attempt", raw.run_attempt),
    status,
    ...spreadIf("conclusion", raw.conclusion ?? undefined),
    event: raw.event ?? "unknown",
    branch: raw.head_branch ?? "",
    sha: raw.head_sha ?? "",
    title,
    ...spreadIf(
      "actor",
      raw.actor?.login ? { login: raw.actor.login, ...spreadIf("avatarUrl", raw.actor.avatar_url) } : undefined,
    ),
    htmlUrl: raw.html_url ?? "",
    createdAt,
    updatedAt,
    startedAt,
    ...spreadIf("durationMs", duration(startedAt, completedAt)),
  }
}

type RawJob = {
  id: number
  name?: string
  status?: string | null
  conclusion?: string | null
  html_url?: string | null
  started_at?: string | null
  completed_at?: string | null
  steps?: Array<{
    name?: string
    number?: number
    status?: string | null
    conclusion?: string | null
    started_at?: string | null
    completed_at?: string | null
  }> | null
}

function normalizeJob(raw: RawJob) {
  const startedAt = timestamp(raw.started_at)
  const completedAt = timestamp(raw.completed_at)
  return {
    id: raw.id,
    name: raw.name ?? "Job",
    status: raw.status ?? "queued",
    ...spreadIf("conclusion", raw.conclusion ?? undefined),
    ...spreadIf("htmlUrl", raw.html_url ?? undefined),
    ...spreadIf("startedAt", startedAt),
    ...spreadIf("completedAt", completedAt),
    ...spreadIf("durationMs", duration(startedAt, completedAt)),
    steps: (raw.steps ?? []).map((step, index) => {
      const stepStarted = timestamp(step.started_at)
      const stepCompleted = timestamp(step.completed_at)
      return {
        name: step.name ?? `Step ${index + 1}`,
        number: step.number ?? index + 1,
        status: step.status ?? "queued",
        ...spreadIf("conclusion", step.conclusion ?? undefined),
        ...spreadIf("startedAt", stepStarted),
        ...spreadIf("completedAt", stepCompleted),
      }
    }),
  }
}

async function withGithub<A>(fn: (token: string) => Promise<A>): Promise<A> {
  const token = await githubToken()
  if (!token) throw noToken()
  try {
    return await fn(token)
  } catch (error) {
    if (error instanceof GithubApiError) throw githubHttpError(error)
    throw error
  }
}

export async function githubWorkflows(owner: string, repo: string) {
  return withGithub(async (token) => {
    const body = (await GithubApi.listWorkflows(token, owner, repo)) as {
      workflows?: Array<{ id: number; name?: string; path?: string; state?: string; html_url?: string }>
    }
    return (body.workflows ?? []).map((workflow) => ({
      id: workflow.id,
      name: workflow.name ?? workflow.path ?? "Workflow",
      path: workflow.path ?? "",
      state: workflow.state ?? "active",
      ...spreadIf("htmlUrl", workflow.html_url),
    }))
  })
}

export async function githubWorkflowRuns(owner: string, repo: string, query: { branch?: string; limit?: number }) {
  return withGithub(async (token) => {
    const body = (await GithubApi.listWorkflowRuns(token, owner, repo, {
      ...spreadIf("branch", query.branch?.trim() || undefined),
      perPage: query.limit ?? 20,
    })) as { workflow_runs?: RawRun[]; total_count?: number }
    const runs = (body.workflow_runs ?? []).map(normalizeRun)
    // An empty list is ambiguous: no runs yet, or no workflows in the repo at all. The panel
    // shows a different empty state for each, so resolve it here rather than in the client.
    const configured =
      runs.length > 0 ||
      (await githubWorkflows(owner, repo)
        .then((workflows) => workflows.length > 0)
        .catch(() => true))
    return { runs, totalCount: body.total_count ?? runs.length, configured }
  })
}

export async function githubWorkflowRunJobs(owner: string, repo: string, runID: number) {
  return withGithub(async (token) => {
    const body = (await GithubApi.listWorkflowRunJobs(token, owner, repo, runID)) as { jobs?: RawJob[] }
    return (body.jobs ?? []).map(normalizeJob)
  })
}

export async function githubWorkflowRunRerun(
  owner: string,
  repo: string,
  runID: number,
  input: typeof MobileGithubRerunInput._output,
) {
  return withGithub(async (token) => {
    await GithubApi.rerunWorkflowRun(token, owner, repo, runID, { failedOnly: input.failedOnly })
    return { success: true as const }
  })
}

export async function githubWorkflowRunCancel(owner: string, repo: string, runID: number) {
  return withGithub(async (token) => {
    await GithubApi.cancelWorkflowRun(token, owner, repo, runID)
    return { success: true as const }
  })
}

export async function githubWorkflowDispatch(
  owner: string,
  repo: string,
  workflowID: string,
  input: typeof MobileGithubWorkflowDispatchInput._output,
) {
  return withGithub(async (token) => {
    await GithubApi.dispatchWorkflow(token, owner, repo, workflowID, input.ref, input.inputs)
    return { success: true as const }
  })
}

export function githubImportsList() {
  return MobileGithubRepo.list()
}

export async function githubOauthClient(input: typeof GithubOAuthClientInput._output) {
  const { key } = await ensureGlobalGithubConnector({
    oauthClientId: input.clientId.trim(),
    clientId: input.clientId.trim(),
  })
  Connectors.invalidateConnector(key)
  Connectors.invalidateConnector("github")
  return configGet()
}

export async function githubOauthDeviceStart() {
  try {
    return await startGithubDeviceAuth()
  } catch (error) {
    throw new MobileHttpError(error instanceof Error ? error.message : String(error), 400)
  }
}

export async function githubOauthDevicePoll(input: typeof MobileGithubDeviceAuthPollInput._output) {
  try {
    return await pollGithubDeviceAuth(input.deviceCode)
  } catch (error) {
    throw new MobileHttpError(error instanceof Error ? error.message : String(error), 400)
  }
}

export async function githubAuthSet(input: typeof GithubAuthInput._output) {
  await storeGithubToken({ accessToken: input.token })
  return { success: true as const }
}

export async function githubAuthRemove() {
  const config = await configGet().catch(() => undefined),
    { key } = githubConnectorEntry(config)
  await runConnectorAuth(
    Effect.gen(function* () {
      const auth = yield* ConnectorAuth.Service
      yield* auth.remove(key)
      if (key !== "github") yield* auth.remove("github")
    }),
  )
  Connectors.invalidateConnector(key)
  Connectors.invalidateConnector("github")
  return { success: true as const }
}

export async function githubImport(input: typeof MobileGithubRepo.ImportRequest._output) {
  const token = await githubToken()
  if (!token) throw noToken()
  return MobileGithubRepo.importRepo(input, token)
}

export async function githubSessionCreate(input: typeof MobileGithubSessionCreateInput._output) {
  const token = await githubToken()
  if (!token) throw noToken()
  const baseBranch = input.baseBranch.trim() || input.defaultBranch
  const imported = await MobileGithubRepo.importRepo(
    {
      owner: input.owner,
      repo: input.repo,
      cloneUrl: input.cloneUrl,
      defaultBranch: input.defaultBranch,
      private: input.private,
    },
    token,
  )
  const seed = sessionSeed(),
    headBranch = `nikcli/mobile/${slug(input.repo)}/${seed}`
  const worktree = await runWorktreeForDirectory(
    imported.import.directory,
    Effect.gen(function* () {
      return yield* (yield* Worktree.Service).create({
        name: `${slug(input.repo)}-${slug(baseBranch)}-${seed}`,
        branch: headBranch,
        baseBranch,
        remote: "origin",
      })
    }),
  )
  if (!worktree.branch) throw new Error("GitHub mobile worktree must have a branch")
  let workspace: Workspace.Info | undefined
  try {
    workspace = await createExecutionWorkspace({
      directory: worktree.directory,
      branch: headBranch,
      target: input.executionTarget,
    })
    const session = await withInstanceAsync({ directory: worktree.directory }, () =>
      WorkspaceContext.provide({
        workspaceID: workspace?.id,
        fn: () =>
          runSession(
            Effect.gen(function* () {
              return yield* (yield* Session.Service).create({
                title: input.title?.trim() || `${input.owner}/${input.repo} ${baseBranch}`,
                workspaceID: workspace?.id,
                github: {
                  owner: input.owner,
                  repo: input.repo,
                  fullName: `${input.owner}/${input.repo}`,
                  baseBranch,
                  headBranch,
                  repositoryDirectory: imported.import.directory,
                  cloneUrl: imported.import.cloneUrl,
                  htmlUrl: input.htmlUrl,
                  private: input.private,
                  worktree: { ...worktree, branch: worktree.branch! },
                },
              })
            }),
          ),
      }),
    )
    return { session, worktree, project: imported.project, workspace }
  } catch (error) {
    if (workspace) await Workspace.remove(workspace.id).catch(() => undefined)
    await runWorktreeForDirectory(
      imported.import.directory,
      Effect.gen(function* () {
        yield* (yield* Worktree.Service).remove({ directory: worktree.directory })
      }),
    ).catch(() => undefined)
    throw error
  }
}
