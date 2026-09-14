/**
 * The decisions behind `ade-msg spawn` as an orchestration tool: what a
 * subagent is called, where it works, how deep the tree may grow, and which
 * options an agent may choose for the session it starts.
 *
 * Pure, like `mailbox.ts`, so each rule is tested rather than trusted.
 */

/** Longest name a session may be given. It is a title and a branch segment. */
export const MAX_NAME = 40

/** How deep sessions may start sessions, unless `ade.mailbox.maxDepth` says otherwise. */
export const DEFAULT_MAX_DEPTH = 2

/**
 * A name as the user will see it and type it, or an error.
 *
 * Refused rather than repaired: the agent that chose it is about to address
 * the session by it, and a name ADE quietly changed is one that agent cannot
 * find. Slashes are out because `progetto/nome` is how another project is
 * named; digits alone are out because a bare number is a position in the list.
 */
export function checkName(raw: string): { name: string } | { error: string } {
  const name = raw.trim()
  if (!name) return { error: "il nome è vuoto" }
  if (name.length > MAX_NAME) return { error: `il nome supera ${MAX_NAME} caratteri` }
  if (/^\d+$/.test(name)) return { error: "il nome non può essere solo un numero (i numeri sono le posizioni in ade-msg list)" }
  // eslint-disable-next-line no-control-regex
  if (/[\\/\u0000-\u001f"]/.test(name)) return { error: "il nome non può contenere / \\ \" o caratteri di controllo" }
  return { name }
}

/** A name another session already has is taken, whatever the case. */
export function nameTaken(titles: readonly string[], name: string): boolean {
  const wanted = name.trim().toLowerCase()
  return titles.some((title) => title.trim().toLowerCase() === wanted)
}

/** The name as a branch and folder segment: lowercase ASCII, digits and dashes. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME)
  return slug || "sessione"
}

/**
 * Where a `--worktree` session works: branch `ade/<slug>`, in a folder beside
 * the project named `<progetto>-ade/<slug>`.
 *
 * Beside and not inside, because a checkout inside the project is a directory
 * every search, watcher and `git status` of the main tree walks into. Beside
 * and not in a temp directory, because on this machine the agents cannot write
 * outside the user's folders, and because the user has to be able to find it.
 */
export function worktreePlan(root: string, slug: string): { branch: string; path: string } {
  const trimmed = root.replace(/[\\/]+$/, "")
  const sep = trimmed.includes("\\") ? "\\" : "/"
  return { branch: `ade/${slug}`, path: `${trimmed}-ade${sep}${slug}` }
}

/**
 * How many `spawn`s separate a session from one the user started: 0 for the
 * user's own, 1 for their subagent, and so on. A cycle — which a hand-edited
 * store could hold — ends the count instead of hanging it.
 */
export function depthOf(paneId: string, parentOf: (paneId: string) => string | undefined): number {
  const seen = new Set<string>([paneId])
  let depth = 0
  let current = parentOf(paneId)
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    depth++
    current = parentOf(current)
  }
  return depth
}

/**
 * Every session below this one, children after their own children, so closing
 * them in order never leaves a session whose parent is already gone.
 */
export function descendants(paneId: string, parents: ReadonlyMap<string, string>): string[] {
  const out: string[] = []
  const visit = (id: string, seen: Set<string>) => {
    for (const [child, parent] of parents) {
      if (parent !== id || seen.has(child)) continue
      seen.add(child)
      visit(child, seen)
      out.push(child)
    }
  }
  visit(paneId, new Set([paneId]))
  return out
}

/**
 * The arguments that choose a model, for the agents whose flag is known.
 *
 * Only the model, and not arbitrary arguments: an agent choosing its
 * subagent's command line could just as well choose
 * `--dangerously-skip-permissions`, and a prompt injected into one session
 * would then run unconfirmed commands in another. The model is the choice
 * that matters for cost, and it cannot widen what a session may do.
 *
 *   claude  --model <m>
 *   codex   -m <m>
 *   agy     --model <m>   (ids from `agy models`)
 */
export function modelArgs(agentId: string, model: string): string[] | { error: string } {
  const value = model.trim()
  if (!/^[A-Za-z0-9._:\-/]{1,80}$/.test(value)) return { error: `modello non valido: ${model}` }
  switch (agentId) {
    case "claude-code":
    case "agy":
      return ["--model", value]
    case "codex":
      return ["-m", value]
    default:
      return { error: `ADE non sa come scegliere il modello per ${agentId}: avvialo senza --model` }
  }
}

/**
 * Arguments a session in a worktree needs to stay in it.
 *
 * agy resolves its workspace to the repository root rather than to the
 * directory it starts in, so from a worktree it reads and edits the main
 * checkout unless the worktree is added explicitly.
 */
export function worktreeArgs(agentId: string, path: string): string[] {
  return agentId === "agy" ? ["--add-dir", path] : []
}

/** Where a subagent writes what does not fit in its reply. */
export function resultsDir(cwd: string): string {
  const sep = cwd.includes("\\") ? "\\" : "/"
  return `${cwd.replace(/[\\/]+$/, "")}${sep}.ade${sep}results`
}

/** The line `.git/info/exclude` needs so results never show up in `git status`, if it is missing. */
export function excludeWithAde(current: string): string | undefined {
  const lines = current.split(/\r?\n/)
  if (lines.some((line) => line.trim() === ".ade/" || line.trim() === ".ade")) return undefined
  const base = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`
  return `${base}# ADE: risultati dei subagent\n.ade/\n`
}
