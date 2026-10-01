/*
 * What closing a session does to the worktree it was given, whichever way it is closed.
 *
 * `spawn --worktree` cuts a checkout and a branch `ade/<slug>` for the session. They are the user's disk and the user's `git branch`: left
 * behind they pile up beside every project. The rule is one for every way of closing (`ade-msg close`, the tab's ✕, the shortcut, closing
 * the project): when the session's work has landed and the folder is clean, the worktree is removed and then its branch; when it has not, both
 * stay, and closing from the user's own hands asks first (`editor/closer.ts`). Closing a session must never delete work.
 *
 * Kept apart from the workbench, with `git` given, so all of it can be driven from a test with a fake one.
 */

import type { RunResult } from "../host/shell"

export type GitRun = (command: string, args: string[], cwd?: string) => Promise<Pick<RunResult, "code" | "stdout" | "stderr">>

/** What is known of the session's worktree when it closes; the pane itself is already gone by the time git runs. */
export interface WorktreeFacts {
  /** The session's name, for the words. */
  title: string
  /** The worktree's folder. */
  worktree: string
  /** The branch the session works on, as the pane recorded it. */
  branch?: string
  /** The project the worktree was cut from: where `git worktree remove` and `git branch -d` run. */
  root?: string
}

export type Reclaimed =
  | { kind: "removed"; branchDeleted: boolean }
  /** The folder stays on disk, with its branch. `reason` says why, in words for the user. */
  | { kind: "kept"; reason: string }

/** The branches ADE cuts itself. Anything else the pane reports (an agent may switch branch inside its worktree) is the user's. */
export const isAdeBranch = (branch: string | undefined): branch is string => Boolean(branch && branch.startsWith("ade/") && branch.length > 4)

/**
 * Why a session's worktree cannot be thrown away yet, or nothing.
 *
 * What firstmate learned the hard way: a worker is torn down when its work has landed, not when it says it is done. Uncommitted changes, or
 * commits on its branch that the project's branch does not have, are work that closing would strand.
 */
export async function worktreeWork(run: GitRun, facts: WorktreeFacts): Promise<string | undefined> {
  // An answer that is not an answer is not «clean»: when git cannot say, the folder stays.
  const status = await run("git", ["status", "--porcelain"], facts.worktree)
  if (status.code !== 0) return `"${facts.title}": git non riesce a dire se ci sono modifiche in ${facts.worktree}`
  if (status.stdout.trim()) return `"${facts.title}" ha modifiche non committate in ${facts.worktree}`
  // Commits made on a detached HEAD, or on a branch ADE did not cut, are in no branch the project's branch can be compared with: removing
  // the folder would leave them to the reflog.
  if (!isAdeBranch(facts.branch)) return `"${facts.title}": non so su quale branch di ADE lavora (${facts.branch ?? "nessuno"}), non posso dire se il lavoro è integrato`
  if (facts.root) {
    const merged = await run("git", ["branch", "--list", facts.branch, "--merged"], facts.root)
    if (merged.code !== 0) return `"${facts.title}": git non riesce a dire se il branch ${facts.branch} è integrato`
    if (!merged.stdout.trim()) return `"${facts.title}" ha commit sul branch ${facts.branch} non ancora integrati`
  }
  return undefined
}

/**
 * Saves what the session wrote under its worktree's `.ade/` into the project's own before the worktree goes (`ade_worktree_rescue`): its
 * results, captures and design notes. `.ade/` is out of git's sight, so `git worktree remove` would take it with the folder and a sub-agent's
 * report would vanish with its tab. It throws when something cannot be saved, and the worktree then stays.
 */
export type Rescue = (root: string, worktree: string) => Promise<number>

/** For a host that cannot save them: the worktree is then kept rather than removed over files nobody has read. */
export const noRescue: Rescue = async () => {
  throw new Error("questo host non può mettere al sicuro i rapporti della sessione")
}

/** Trying `git worktree remove` again: the session's process may still be leaving the folder (on Windows it holds it until it has gone). */
export interface Retry {
  times: number
  ms: number
  wait: (ms: number) => Promise<void>
}

/**
 * Removes the worktree and then its branch, when the work has landed and the folder is clean; otherwise nothing is touched. What the session
 * left in its `.ade/` is saved into the project's first (`rescue`), and if that fails the worktree stays.
 *
 * The branch goes with `git branch -d`, never `-D`: git refuses by itself a branch the project's branch does not contain, so even a wrong
 * answer above cannot lose a commit. Only `ade/*` branches are deleted. A worktree git will not remove (a file it holds is open, say) stays,
 * and so does its branch, which is still checked out there.
 */
export async function reclaimWorktree(run: GitRun, facts: WorktreeFacts, rescue: Rescue, retry?: Retry): Promise<Reclaimed> {
  const work = await worktreeWork(run, facts)
  if (work) return { kind: "kept", reason: work }
  if (!facts.root) return { kind: "kept", reason: `"${facts.title}": non trovo il progetto da cui è nata la worktree ${facts.worktree}` }
  // Saved before anything is removed, and tried again like the removal: the session's process may still be leaving its files.
  let saved: unknown
  for (let again = 0; again <= (retry?.times ?? 0); again++) {
    if (again > 0) await retry!.wait(retry!.ms)
    try {
      await rescue(facts.root, facts.worktree)
      saved = undefined
      break
    } catch (error) {
      saved = error
    }
  }
  if (saved !== undefined) {
    const said = saved instanceof Error ? saved.message : String(saved)
    return { kind: "kept", reason: `"${facts.title}": non riesco a mettere al sicuro i rapporti della sessione, la worktree resta in ${facts.worktree} (${said})` }
  }
  let removed = await run("git", ["worktree", "remove", facts.worktree], facts.root)
  for (let again = 0; removed.code !== 0 && retry && again < retry.times; again++) {
    await retry.wait(retry.ms)
    removed = await run("git", ["worktree", "remove", facts.worktree], facts.root)
  }
  if (removed.code !== 0) {
    const said = (removed.stderr || removed.stdout).trim().split(/\r?\n/)[0] || "git ha rifiutato"
    return { kind: "kept", reason: `"${facts.title}": git non toglie ${facts.worktree} (${said})` }
  }
  if (!isAdeBranch(facts.branch)) return { kind: "removed", branchDeleted: false }
  const deleted = await run("git", ["branch", "-d", facts.branch], facts.root)
  return { kind: "removed", branchDeleted: deleted.code === 0 }
}
