/**
 * Whether nikcli may load the open project's own configuration (B3b, review
 * B3, M2).
 *
 * Every nikcli turn runs in the project, a bot of the user's included, and
 * nikcli then loads what the project brings: `nikcli.json`, and `.nikcli/`
 * with its plugins and tools — code, run as nikcli starts — and a
 * `package.json` whose scripts `bun install` runs there. A cloned repository
 * can bring all of it. The user opening nikcli in that folder has decided to;
 * ADE doing it on a bot's first message has not asked. So it asks, once per
 * project, and again when any of it changes: the answer holds for the
 * SHA-256 of those files as they are.
 *
 * Claude Code and Codex do not read `.nikcli/`, so only nikcli turns ask.
 * The voice never runs on nikcli (`voice/agent.ts`).
 */

import { joinPath } from "../host/path"
import { t } from "../i18n"
import { fileFingerprint, selfApproval, type TrustStore } from "./trust"

/** The two calls this needs from the host, as `host/shell.ts` has them. */
export interface ProjectFs {
  readDir: (path: string) => Promise<readonly { readonly name: string; readonly is_dir: boolean }[]>
  readText: (path: string) => Promise<{ readonly text: string; readonly truncated: boolean }>
}

/** One file nikcli would load, by its path under the project. */
export interface SurfaceFile {
  readonly path: string
  readonly text: string
}

/** Written by nikcli itself when it prepares `.nikcli/`: not the project's say. */
const NIKCLI_WRITES = new Set([".gitignore", "bun.lock", "bun.lockb"])
/** Bots: each is asked about on its own (`trust.ts`), unless it grants itself permissions. */
const AGENT_DIRS = new Set(["agent", "agents"])
const MAX_DEPTH = 8
const MAX_FILES = 400

/*
 * `.nikcli/package.json` without the one dependency nikcli adds to it on the
 * first turn, so that turn does not make the project a stranger. Its scripts
 * stay: `bun install` runs them.
 */
function normalizedPackage(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text
  const copy = { ...(parsed as Record<string, unknown>) }
  const dependencies = copy["dependencies"]
  if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
    const rest = { ...(dependencies as Record<string, unknown>) }
    delete rest["@nikcli-ai/plugin"]
    if (Object.keys(rest).length === 0) delete copy["dependencies"]
    else copy["dependencies"] = rest
  }
  if (Object.keys(copy).length === 0) return undefined
  return stableJson(copy)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

async function readOrMark(fs: ProjectFs, path: string): Promise<string | undefined> {
  try {
    const read = await fs.readText(path)
    // A file cut short could change past the cut unseen; the mark says so.
    return read.truncated ? `${read.text}\n<troncato>` : read.text
  } catch {
    return undefined
  }
}

/**
 * What nikcli would load from the project at `root`, sorted by path. Empty
 * when the project has no configuration of its own.
 */
export async function projectSurface(root: string, fs: ProjectFs): Promise<SurfaceFile[]> {
  const found: SurfaceFile[] = []

  for (const name of ["nikcli.json", "nikcli.jsonc"]) {
    const text = await readOrMark(fs, joinPath(root, name))
    if (text !== undefined) found.push({ path: name, text })
  }

  let count = 0
  const walk = async (directory: string, relative: string, depth: number, inAgents: boolean): Promise<void> => {
    let entries: Awaited<ReturnType<ProjectFs["readDir"]>>
    try {
      entries = await fs.readDir(directory)
    } catch {
      return
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = joinPath(directory, entry.name)
      const rel = `${relative}/${entry.name}`
      if (entry.is_dir) {
        if (entry.name === "node_modules") continue
        if (depth >= MAX_DEPTH) {
          found.push({ path: rel, text: "<troppo profondo>" })
          continue
        }
        await walk(path, rel, depth + 1, inAgents || (depth === 0 && AGENT_DIRS.has(entry.name)))
        continue
      }
      if (depth === 0 && NIKCLI_WRITES.has(entry.name)) continue
      if (++count > MAX_FILES) {
        // Too many to read one by one: the count stands in for them, so the
        // question is still asked and a change in number asks again.
        found.push({ path: `${relative}/…`, text: `<oltre ${MAX_FILES} file>` })
        return
      }
      const text = await readOrMark(fs, path)
      if (inAgents) {
        if (text !== undefined && selfApproval(text) === undefined) continue
        found.push({ path: rel, text: text ?? "<non leggibile>" })
        continue
      }
      if (depth === 0 && entry.name === "package.json") {
        const normalized = text === undefined ? "<non leggibile>" : normalizedPackage(text)
        if (normalized !== undefined) found.push({ path: rel, text: normalized })
        continue
      }
      found.push({ path: rel, text: text ?? "<non leggibile>" })
    }
  }
  await walk(joinPath(root, ".nikcli"), ".nikcli", 0, false)

  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** One fingerprint for all of it: paths and contents. */
export async function surfaceFingerprint(files: readonly SurfaceFile[]): Promise<string> {
  return fileFingerprint(files.map((file) => `${file.path}\n${file.text}\n\u0000`).join(""))
}

export interface AdmitProjectDeps {
  readonly store: TrustStore
  readonly surface: () => Promise<readonly SurfaceFile[]>
  /** Asks the user; true is yes. */
  readonly confirm: (question: string) => boolean | Promise<boolean>
}

/** Where the yes to each project is kept (`localTrustStore`). */
export const PROJECT_TRUST_KEY = "ade.projects.trusted"

const asking = new Set<string>()

/** How the files are named in the question: the first few, then how many more. */
function listed(files: readonly SurfaceFile[]): string {
  const shown = files.slice(0, 6).map((file) => file.path.replace(/^\.nikcli\//, ""))
  const more = files.length - shown.length
  return more > 0 ? `${shown.join(", ")}${t("bots.projectTrust.more", more)}` : shown.join(", ")
}

/**
 * Whether a nikcli turn may run in the project at `root` now. Asked when the
 * project's configuration is new to the user or changed since the yes.
 */
export async function admitProject(
  root: string,
  deps: AdmitProjectDeps,
): Promise<{ ok: true } | { ok: false; problem?: string }> {
  if (asking.has(root)) return { ok: false }
  const files = await deps.surface()
  if (files.length === 0) return { ok: true }
  const fingerprint = await surfaceFingerprint(files)
  const trusted = deps.store.get(root)
  if (trusted === fingerprint) return { ok: true }
  const question =
    trusted === undefined
      ? t("bots.projectTrust.new", root, listed(files))
      : t("bots.projectTrust.changed", root, listed(files))
  asking.add(root)
  try {
    if (!(await deps.confirm(question))) return { ok: false, problem: t("bots.projectTrust.refused", root) }
  } finally {
    asking.delete(root)
  }
  deps.store.set(root, fingerprint)
  return { ok: true }
}
