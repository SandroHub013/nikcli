/**
 * Bringing a session's work back into the project.
 *
 * ADE hands every session its own checkout, and until the work returns the
 * isolation is only half a feature. What makes this delicate is that the same
 * four git operations differ enormously in what they can cost the user, so the
 * plan is built first, in full, and shown before anything runs.
 *
 * Two rules the planner never breaks: no step may discard work (`--force` and
 * `reset --hard` are refused outright), and anything that could go wrong is
 * named in `warnings` rather than silently prevented — the user knows things
 * about their repository that this module does not.
 */
import type { Host } from "../host/shell"

export type IntegrationMode = "merge" | "rebase" | "cherry-pick" | "patch"

export interface IntegrationPlan {
  /** Branch the session worked on. */
  branch: string
  /** Where it is going, normally the project's branch. */
  onto: string
  mode: IntegrationMode
  /** Git invocations, in order, each with the directory it runs in. */
  steps: { args: string[]; cwd: "project" | "tree" }[]
  /** One sentence for the user to read before pressing. */
  summary: string
  /** Reasons this is risky right now. Empty when it is clean. */
  warnings: string[]
}

/** Arguments no plan may contain, whatever the mode. */
const DESTRUCTIVE = [
  ["--force"],
  ["-f"],
  ["reset", "--hard"],
]

function isDestructive(args: string[]): boolean {
  return DESTRUCTIVE.some((forbidden) => forbidden.every((token) => args.includes(token)))
}

const MODE_SUMMARY: Record<IntegrationMode, (branch: string, onto: string) => string> = {
  merge: (branch, onto) => `unisce ${branch} in ${onto} con un commit di merge`,
  rebase: (branch, onto) => `riallinea ${branch} su ${onto}, poi fa avanzare il progetto`,
  "cherry-pick": (branch, onto) => `applica i commit di ${branch} su ${onto}, uno per uno`,
  patch: (branch) => `porta le modifiche di ${branch} nel progetto senza committarle`,
}

export function planIntegration(input: {
  branch: string
  onto: string
  mode: IntegrationMode
  /** Uncommitted files in the session's checkout. */
  treeDirty: number
  /** Uncommitted files in the project. */
  projectDirty: number
  /** Commits the session has that `onto` does not. */
  ahead: number
}): IntegrationPlan {
  const steps: { args: string[]; cwd: "project" | "tree" }[] = []
  const warnings: string[] = []

  /*
   * Every mode writes into the project's working tree, `patch` included — it
   * is `merge --squash`, which stops on a dirty tree exactly like the others.
   * Calling it safe because it makes no commit would be the wrong kind of
   * reassurance.
   */
  if (input.projectDirty > 0) {
    warnings.push(
      input.mode === "patch"
        ? `Il progetto ha ${input.projectDirty} file non salvati: le modifiche della sessione si mescoleranno ai tuoi.`
        : `Il progetto ha ${input.projectDirty} file non salvati: git può rifiutarsi di procedere.`,
    )
  }

  // Nothing to integrate: the work exists only as uncommitted changes in the
  // session's tree, so it has to become a commit before any mode can move it.
  const commitsFirst = input.ahead === 0 && input.treeDirty > 0
  if (commitsFirst) {
    steps.push({ args: ["add", "-A"], cwd: "tree" })
    steps.push({ args: ["commit", "-m", "Lavoro della sessione"], cwd: "tree" })
  }

  if (input.ahead === 0 && input.treeDirty === 0) {
    warnings.push("La sessione non ha prodotto niente da integrare.")
  }

  if (input.mode === "merge") {
    steps.push({
      args: ["merge", "--no-ff", "-m", `Merge branch '${input.branch}'`, input.branch],
      cwd: "project",
    })
  } else if (input.mode === "rebase") {
    // The tree is already on its own branch, so rebasing needs no checkout.
    // The project then fast-forwards, which is why this mode leaves no merge
    // commit behind and why it can only fail cleanly.
    steps.push({ args: ["rebase", input.onto], cwd: "tree" })
    steps.push({ args: ["merge", "--ff-only", input.branch], cwd: "project" })
  } else if (input.mode === "cherry-pick") {
    steps.push({ args: ["cherry-pick", `${input.onto}..${input.branch}`], cwd: "project" })
  } else {
    steps.push({ args: ["merge", "--squash", input.branch], cwd: "project" })
  }

  for (const step of steps) {
    if (isDestructive(step.args)) {
      throw new Error(`Passo distruttivo rifiutato: git ${step.args.join(" ")}`)
    }
  }

  const action = MODE_SUMMARY[input.mode](input.branch, input.onto)
  const summary = commitsFirst
    ? `Committa il lavoro non salvato nell'albero della sessione, poi ${action}.`
    : `${action.charAt(0).toUpperCase()}${action.slice(1)}.`

  return { branch: input.branch, onto: input.onto, mode: input.mode, steps, summary, warnings }
}

export interface IntegrationResult {
  ok: boolean
  /** The step that failed, spelled as it was run. */
  failedStep?: string
  /** First line of git's complaint, which is usually the whole explanation. */
  reason?: string
  /** True when git stopped on a conflict: a decision to make, not a failure. */
  conflict: boolean
  conflicts: string[]
}

/**
 * Runs a plan, stopping at the first step that fails.
 *
 * Nothing is rolled back. Git leaves a stopped merge or rebase in a state the
 * user can finish or abort, and undoing that behind their back would throw
 * away the half of the work git already did.
 */
export async function runIntegration(input: {
  host: Host
  projectPath: string
  treePath: string
  plan: IntegrationPlan
}): Promise<IntegrationResult> {
  const { host, projectPath, treePath, plan } = input

  for (const step of plan.steps) {
    const cwd = step.cwd === "project" ? projectPath : treePath
    const result = await host.run("git", step.args, cwd)
    if (result.code === 0) continue

    /*
     * Whether this is a conflict is asked of the repository, not of git's
     * prose. Matching on "CONFLICT" reads the message in whatever language
     * the user's git speaks, and gets it wrong in every one but English.
     */
    const status = await host.run("git", ["status", "--porcelain"], cwd)
    const conflicts = status.code === 0 ? collectConflicts(status.stdout) : []

    const firstLine = (text: string) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)

    return {
      ok: false,
      failedStep: `git ${step.args.join(" ")}`,
      reason: firstLine(result.stderr) ?? firstLine(result.stdout) ?? "Comando fallito",
      conflict: conflicts.length > 0,
      conflicts,
    }
  }

  return { ok: true, conflict: false, conflicts: [] }
}

/** Paths git reports as conflicted, from `git status --porcelain`. */
export function collectConflicts(statusPorcelain: string): string[] {
  // The unmerged states, per git's own table: either side unmerged, or both
  // added, or both deleted.
  const markers = new Set(["UU", "AA", "DU", "UD", "AU", "UA", "DD"])
  const conflicts: string[] = []

  for (const line of statusPorcelain.split("\n")) {
    if (line.length < 4) continue
    if (!markers.has(line.slice(0, 2))) continue

    let path = line.slice(3).trim()
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
    conflicts.push(path)
  }

  return conflicts
}
