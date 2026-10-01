/*
 * «Spazio su disco»: what ADE keeps on the user's computer, row by row, and the button that gives each back.
 *
 * One row for each thing ADE put there that can be taken away again: the local voices (Piper's, one for each voice, and Kokoro), NikVerse's
 * assets, the worktrees of finished sessions, the `ade/*` branches that have landed, and the captures and results of a project's `.ade/` that
 * are old. Each row says what it weighs and, if it can go, has one button. Nothing goes without a question that says how much it frees, and
 * the panel never touches work that has not landed (a worktree with changes, or commits the project's branch does not have is listed and
 * kept), a session's own folder while the session is open, the secrets, the decisions or the memory of a project.
 *
 * The controller holds no interface: it is given the host, the question and what is open, and says what the rows are. The panel only draws it.
 */

import type { RunResult } from "../host/shell"
import { t } from "../i18n"
import { pruneFolders, pruneSummary, trackedFiles, type Listed } from "../session/ade-prune"
import { isAdeBranch, noRescue, reclaimWorktree, worktreeWork } from "../session/worktree-close"

export type Group = "voices" | "assets" | "worktrees" | "branches" | "project"

export interface Row {
  id: string
  group: Group
  title: string
  detail?: string
  /** What it frees, when it is known. */
  bytes?: number
  /** The button; absent when the row is only listed. */
  action?: string
  /** Why it is listed and not offered: the work in it that has not landed, or what holds it. */
  kept?: string
}

/** What the panel needs of the host: every method is optional, a row whose method is missing is not there. */
export interface SpaceHost {
  ttsDiskReport?: () => Promise<{ piper: { runtime: number; voices: { id: string; bytes: number }[] }; kokoro: number }>
  ttsPiperDelete?: (voiceId?: string) => Promise<number>
  ttsLocalDelete?: (provider: string) => Promise<void>
  nikverseAssetsBytes?: () => Promise<number>
  nikverseAssetsRemove?: () => Promise<number>
  run?: (command: string, args: string[], cwd?: string) => Promise<Pick<RunResult, "code" | "stdout" | "stderr">>
  readDir?: (path: string) => Promise<(Listed & { size?: number })[]>
  adePrune?: (paths: string[]) => Promise<number>
  adeContainerRemove?: (root: string) => Promise<boolean>
  adeWorktreeBytes?: (root: string, worktree: string) => Promise<number>
  adeWorktreeRescue?: (root: string, worktree: string) => Promise<number>
}

export interface SpaceDeps {
  host: SpaceHost
  /** The projects that are open (their roots). */
  roots: () => readonly string[]
  /** The folders of the worktrees that have a session open in them: they are not offered. */
  openWorktrees: () => readonly string[]
  /** The question, in the user's words; true is a yes. */
  ask: (message: string) => Promise<boolean>
  now: () => number
}

export type Outcome =
  | { kind: "done"; freed: number }
  /** The user said no, or the row has no button: nothing was done. */
  | { kind: "declined" }
  | { kind: "listed"; why: string }
  | { kind: "failed"; reason: string }
  | { kind: "gone" }

/** A size as a person reads it. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1000) return `${Math.round(bytes)} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`
  if (bytes < 1_000_000_000) {
    const mb = bytes / 1_000_000
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  }
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}

/** A path as two paths can be compared: forward slashes, no trailing one, and a drive letter in lower case. */
export function normalized(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "")
  return /^[A-Za-z]:/.test(slashed) ? slashed[0]!.toLowerCase() + slashed.slice(1) : slashed
}

export interface ListedWorktree {
  path: string
  branch?: string
  locked: boolean
}

/** `git worktree list --porcelain`: a block for each worktree, the main one first. */
export function parseWorktrees(porcelain: string): ListedWorktree[] {
  const out: ListedWorktree[] = []
  let current: ListedWorktree | undefined
  for (const raw of porcelain.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), locked: false }
      out.push(current)
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true
    }
  }
  return out
}

/** The branches `git branch --list --merged` offers to delete: not the current one (`*`) nor one checked out in another worktree (`+`). */
export function plainBranches(listing: string): string[] {
  return listing
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^[*+]/.test(line.trim()))
    .map((line) => line.trim())
}

const containerOf = (root: string) => `${normalized(root)}-worktrees`
const insideContainer = (root: string, path: string) => normalized(path).startsWith(`${containerOf(root)}/`)
const nameOf = (path: string) => normalized(path).split("/").pop() || path

export function createSpace(deps: SpaceDeps) {
  const { host } = deps
  let current: Row[] = []
  /** What each row needs to be carried out, kept apart from the row the panel draws. */
  const plans = new Map<string, () => Promise<number>>()
  const listeners = new Set<() => void>()
  let busy = false

  const git = async (args: string[], cwd: string) => {
    if (!host.run) return undefined
    try {
      const result = await host.run("git", args, cwd)
      return result.code === 0 ? result : undefined
    } catch {
      return undefined
    }
  }

  async function voiceRows(rows: Row[]) {
    const report = await host.ttsDiskReport?.().catch(() => undefined)
    if (!report) return
    const voices = report.piper.voices
    voices.forEach((voice) => {
      // The last voice takes the runtime with it, so that is what removing it frees.
      const last = voices.length === 1
      const bytes = voice.bytes + (last ? report.piper.runtime : 0)
      const id = `piper:${voice.id}`
      rows.push({
        id,
        group: "voices",
        title: t("space.piper", voice.id),
        ...(last ? { detail: t("space.piper.runtime") } : {}),
        bytes,
        ...(host.ttsPiperDelete ? { action: t("space.remove") } : {}),
      })
      if (host.ttsPiperDelete) plans.set(id, () => host.ttsPiperDelete!(voice.id))
    })
    if (voices.length === 0 && report.piper.runtime > 0 && host.ttsPiperDelete) {
      rows.push({ id: "piper:all", group: "voices", title: t("space.piper.leftover"), bytes: report.piper.runtime, action: t("space.remove") })
      plans.set("piper:all", () => host.ttsPiperDelete!())
    }
    if (report.kokoro > 0 && host.ttsLocalDelete) {
      rows.push({ id: "kokoro", group: "voices", title: t("space.kokoro"), bytes: report.kokoro, action: t("space.remove") })
      plans.set("kokoro", async () => {
        await host.ttsLocalDelete!("kokoro")
        return report.kokoro
      })
    }
  }

  async function assetRows(rows: Row[]) {
    const bytes = await host.nikverseAssetsBytes?.().catch(() => 0)
    if (!bytes || !host.nikverseAssetsRemove) return
    rows.push({ id: "nikverse", group: "assets", title: t("space.nikverse"), detail: t("space.nikverse.again"), bytes, action: t("space.remove.again") })
    plans.set("nikverse", () => host.nikverseAssetsRemove!())
  }

  async function projectRows(rows: Row[], root: string) {
    const trees = await git(["worktree", "list", "--porcelain"], root)
    const listed = trees ? parseWorktrees(trees.stdout) : []
    const open = new Set(deps.openWorktrees().map(normalized))
    for (const tree of listed) {
      if (normalized(tree.path) === normalized(root) || !insideContainer(root, tree.path) || !isAdeBranch(tree.branch)) continue
      if (open.has(normalized(tree.path))) continue
      const id = `worktree:${normalized(tree.path)}`
      const bytes = await host.adeWorktreeBytes?.(root, tree.path).catch(() => 0)
      const facts = { title: nameOf(tree.path), worktree: tree.path, branch: tree.branch, root }
      const work = host.run ? await worktreeWork(async (command, args, cwd) => host.run!(command, args, cwd), facts).catch(() => t("space.worktree.unknown")) : t("space.worktree.unknown")
      const why = tree.locked ? t("space.worktree.locked") : work
      rows.push({
        id,
        group: "worktrees",
        title: nameOf(tree.path),
        detail: `${tree.branch} · ${normalized(tree.path)}`,
        ...(bytes ? { bytes } : {}),
        ...(why ? { kept: why } : { action: t("space.worktree.remove") }),
      })
      if (!why) {
        plans.set(id, async () => {
          const result = await reclaimWorktree(async (command, args, cwd) => host.run!(command, args, cwd), facts, host.adeWorktreeRescue ?? noRescue)
          if (result.kind === "kept") throw new Error(result.reason)
          await host.adeContainerRemove?.(root).catch(() => false)
          return bytes ?? 0
        })
      }
    }

    // The branches that have landed and have no worktree: `+` marks one that is checked out in another, which git would refuse anyway.
    const merged = await git(["branch", "--list", "ade/*", "--merged"], root)
    const branches = merged ? plainBranches(merged.stdout).filter(isAdeBranch) : []
    if (branches.length > 0) {
      const id = `branches:${normalized(root)}`
      rows.push({
        id,
        group: "branches",
        title: t("space.branches", String(branches.length)),
        detail: branches.slice(0, 4).join(", ") + (branches.length > 4 ? ", …" : ""),
        action: t("space.worktree.remove"),
      })
      plans.set(id, async () => {
        for (const branch of branches) await git(["branch", "-d", branch], root)
        return 0
      })
    }

    // What git tracks is the project's: with no answer from git nothing of `.ade/` is offered.
    const tracked = host.run ? await trackedFiles(async (command, args, cwd) => host.run!(command, args, cwd), root) : undefined
    if (host.readDir && host.adePrune && tracked) {
      const folders = pruneFolders(root)
      const read = (folder: string) => host.readDir!(folder).catch(() => [] as (Listed & { size?: number })[])
      const [browser, results, notes] = await Promise.all([read(folders.browser), read(folders.results), read(folders.notes)])
      const summary = pruneSummary({ browser, results, notes }, deps.now(), tracked)
      if (summary.paths.length > 0) {
        const id = `prune:${normalized(root)}`
        rows.push({
          id,
          group: "project",
          title: t("space.prune", nameOf(root)),
          detail: t("space.prune.detail", String(summary.paths.length)),
          bytes: summary.bytes,
          action: t("space.prune.action"),
        })
        plans.set(id, () => host.adePrune!(summary.paths))
      }
    }
  }

  const notify = () => listeners.forEach((listener) => listener())

  const api = {
    rows: () => current,
    busy: () => busy,
    onChange(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    /** Reads the disk again. */
    async refresh() {
      const rows: Row[] = []
      plans.clear()
      await voiceRows(rows)
      await assetRows(rows)
      for (const root of deps.roots()) await projectRows(rows, root)
      current = rows
      notify()
      return rows
    },

    /** The words of the question for a row: what goes, and how much it frees. */
    confirmText(row: Row): string {
      const frees = row.bytes !== undefined ? t("space.confirm.frees", formatBytes(row.bytes)) : t("space.confirm.frees.none")
      return `${row.title}${row.detail ? `\n${row.detail}` : ""}\n\n${frees}\n\n${t("space.confirm.ask")}`
    },

    /** The row's button. Asks first; nothing is done on a no. */
    async remove(id: string): Promise<Outcome> {
      const row = current.find((candidate) => candidate.id === id)
      const plan = plans.get(id)
      if (!row) return { kind: "gone" }
      if (!row.action || !plan) return { kind: "listed", why: row.kept ?? "" }
      if (busy) return { kind: "declined" }
      busy = true
      notify()
      try {
        if (!(await deps.ask(api.confirmText(row)))) return { kind: "declined" }
        try {
          const freed = await plan()
          await api.refresh()
          return { kind: "done", freed }
        } catch (error) {
          await api.refresh().catch(() => undefined)
          return { kind: "failed", reason: error instanceof Error ? error.message : String(error) }
        }
      } finally {
        busy = false
        notify()
      }
    },
  }
  return api
}

export type Space = ReturnType<typeof createSpace>
