/**
 * Whether ragu may load the open project's own configuration (B3b, review
 * B3, M2).
 *
 * Every ragu turn runs in the project, a bot of the user's included, and
 * ragu then loads what the project brings: `nikcli.json`, and `.nikcli/`
 * with its plugins and tools — code, run as ragu starts — and a
 * `package.json` whose scripts `bun install` runs there. A cloned repository
 * can bring all of it. The user opening ragu in that folder has decided to;
 * ADE doing it on a bot's first message has not asked. So it asks, once per
 * project, and again when any of it changes: the answer holds for the
 * SHA-256 of those files as they are.
 *
 * Claude Code and Codex do not read `.nikcli/`, so only ragu turns ask.
 * The voice never runs on ragu (`voice/agent.ts`).
 */

import { dirname, joinPath, normalizePath } from "../host/path"
import { t } from "../i18n"
import type { AgentFile } from "./ragu"
import { fileFingerprint, reachesShell, selfApproval, type TrustStore } from "./trust"

/** The two calls this needs from the host, as `host/shell.ts` has them. */
export interface ProjectFs {
  readDir: (path: string) => Promise<readonly { readonly name: string; readonly is_dir: boolean }[]>
  readText: (path: string) => Promise<{ readonly text: string; readonly truncated: boolean }>
  /**
   * The user's home folder, when the host can say: ragu reads `~/.nikcli` for every project
   * (it is the user's own), so the climb through the ancestors stops short of it.
   */
  home?: () => Promise<string | undefined>
}

/** One file ragu would load, by its path under the project. */
export interface SurfaceFile {
  readonly path: string
  readonly text: string
}

/** Written by ragu itself when it prepares `.nikcli/`: not the project's say. */
const RAGU_WRITES = new Set([".gitignore", "bun.lock", "bun.lockb"])
/** Bots: each is asked about on its own (`trust.ts`), unless it grants itself permissions. */
const AGENT_DIRS = new Set(["agent", "agents"])
const MAX_DEPTH = 8
const MAX_FILES = 400

/*
 * `.nikcli/package.json` without the one dependency ragu adds to it on the
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
 * The folders above `root` that ragu also reads, nearest first.
 *
 * ragu looks for `nikcli.json` and `.nikcli/` from the folder it runs in up to the worktree
 * root: the git root, or outside git the root of the disk (`ConfigPaths.directories`). A
 * project below the git root, or a folder with no git of its own, so runs what its ancestors
 * bring, and a clone's `repo/.nikcli/plugin` was never part of the question asked for
 * `repo/packages/app` (full review 2026-10-06, bots 6). The climb stops at the folder that
 * holds `.git` (included, as ragu includes its worktree), and short of the user's home, whose
 * `.nikcli` is the user's own.
 */
async function ancestorFolders(root: string, fs: ProjectFs): Promise<string[]> {
  const home = normalizePath((await fs.home?.().catch(() => undefined)) ?? "").toLowerCase()
  const holdsGit = async (directory: string) => {
    try {
      return (await fs.readDir(directory)).some((entry) => entry.name === ".git")
    } catch {
      return false
    }
  }
  const aboveHome = (directory: string) => {
    if (!home) return false
    const folder = normalizePath(directory).toLowerCase()
    return folder === home || home.startsWith(folder.endsWith("/") ? folder : `${folder}/`)
  }
  const found: string[] = []
  let current = root
  // The count only bounds a loop that `dirname` ends anyway at the root of the disk.
  for (let level = 0; level < 64; level++) {
    if (await holdsGit(current)) break
    const parent = dirname(current)
    if (parent === current || parent === "." || aboveHome(parent)) break
    found.push(parent)
    current = parent
  }
  return found
}

/**
 * What ragu would load from the project at `root`, and from the folders above it that it also
 * reads, sorted by path (those under `../`). Empty when there is no configuration of its own.
 */
export async function projectSurface(root: string, fs: ProjectFs): Promise<SurfaceFile[]> {
  const found = await surfaceAt(root, "", fs)
  const ancestors = await ancestorFolders(root, fs)
  for (const [index, folder] of ancestors.entries()) {
    found.push(...(await surfaceAt(folder, "../".repeat(index + 1), fs)))
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** One folder's own configuration: its `nikcli.json(c)` and `.nikcli/`, named under `prefix`. */
async function surfaceAt(folder: string, prefix: string, fs: ProjectFs): Promise<SurfaceFile[]> {
  const found: SurfaceFile[] = []
  // The root of a disk (`C:/`, `/`) already ends in a slash: `C://.nikcli` is not the folder.
  const root = normalizePath(folder).replace(/\/+$/, "")

  for (const name of ["nikcli.json", "nikcli.jsonc"]) {
    const text = await readOrMark(fs, `${root}/${name}`)
    if (text !== undefined) found.push({ path: `${prefix}${name}`, text })
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
      if (depth === 0 && RAGU_WRITES.has(entry.name)) continue
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
  await walk(`${root}/.nikcli`, `${prefix}.nikcli`, 0, false)

  return found
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

/**
 * The check under way for each project, shared: whoever asks meanwhile gets
 * the same answer, and the user one dialog. Before, a second caller got a
 * bare `{ ok: false }`, which the chat read as a no for good (C2 review, M2).
 */
const asking = new Map<string, Promise<{ ok: true } | { ok: false; problem?: string }>>()

/** How the files are named in the question: the first few, then how many more. */
function listed(files: readonly SurfaceFile[]): string {
  const shown = files.slice(0, 6).map((file) => file.path.replace(/^\.nikcli\//, ""))
  const more = files.length - shown.length
  return more > 0 ? `${shown.join(", ")}${t("bots.projectTrust.more", more)}` : shown.join(", ")
}

/**
 * Whether a ragu turn may run in the project at `root` now. Asked when the
 * project's configuration is new to the user or changed since the yes.
 */
export async function admitProject(
  root: string,
  deps: AdmitProjectDeps,
): Promise<{ ok: true } | { ok: false; problem?: string }> {
  const under = asking.get(root)
  if (under) return under
  const check = checkProject(root, deps)
  asking.set(root, check)
  try {
    return await check
  } finally {
    asking.delete(root)
  }
}

async function checkProject(
  root: string,
  deps: AdmitProjectDeps,
): Promise<{ ok: true } | { ok: false; problem?: string }> {
  const files = await deps.surface()
  if (files.length === 0) return { ok: true }
  const fingerprint = await surfaceFingerprint(files)
  const trusted = deps.store.get(root)
  if (trusted === fingerprint) return { ok: true }
  const question =
    trusted === undefined
      ? t("bots.projectTrust.new", root, listed(files))
      : t("bots.projectTrust.changed", root, listed(files))
  try {
    if (!(await deps.confirm(question))) return { ok: false, problem: t("bots.projectTrust.refused", root) }
  } catch {
    return { ok: false, problem: t("bots.projectTrust.failed", root) }
  }
  deps.store.set(root, fingerprint)
  return { ok: true }
}

/*
 * The configuration ragu reads in the project whatever the bot: the root
 * `nikcli.json` and `.nikcli/nikcli.json`. ADE's server loads both for every
 * bot's turn (B8d).
 */
const CONFIG_FILES = ["nikcli.json", "nikcli.jsonc", ".nikcli/nikcli.json", ".nikcli/nikcli.jsonc"]

/** Whether `path`, relative to the project as `projectSurface` names it, is one of ragu's configuration files. */
export function isConfigFile(path: string): boolean {
  return CONFIG_FILES.includes(path)
}

/** JSON with comments and trailing commas, as ragu reads its configuration; `undefined` when it is not. */
export function parseJsonc(text: string): unknown {
  let plain = ""
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"') {
      const end = /"(?:[^"\\\n]|\\.)*"/y
      end.lastIndex = index
      const string = end.exec(text)
      if (!string) return undefined
      plain += string[0]
      index = end.lastIndex - 1
    } else if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index)
      index = newline === -1 ? text.length : newline - 1
    } else if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2)
      if (close === -1) return undefined
      index = close + 1
    } else plain += char
  }
  try {
    return JSON.parse(plain.replace(/,(\s*[}\]])/g, "$1"))
  } catch {
    return undefined
  }
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/*
 * The first grant of the shell or of a folder outside in a `permission` or
 * `tools` value, as a path to take out (`agent.revisore.permission.bash`).
 * What is neither a string nor a map counts as a grant: ragu is the one
 * that decides what it means.
 */
function grantIn(kind: "permission" | "tools", value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined
  if (kind === "permission" && typeof value === "string") return value === "allow" ? at : undefined
  if (!isMap(value)) return at
  for (const [name, rule] of Object.entries(value)) {
    if (!reachesShell(name)) continue
    const path = `${at}.${JSON.stringify(name)}`
    if (kind === "tools") {
      if (rule === true) return path
      continue
    }
    if (rule === "allow") return path
    if (typeof rule === "string") continue
    if (!isMap(rule)) return path
    for (const [pattern, action] of Object.entries(rule)) {
      if (action === "allow" || typeof action !== "string") return `${path}.${JSON.stringify(pattern)}`
    }
  }
  return undefined
}

/**
 * What a project's ragu configuration grants the bot `identifier` that
 * reaches the shell or a folder outside (B8c): its own `permission` and
 * `tools`, and those of `agent.<identifier>` (and the older `mode`), which
 * ragu merges with the bot's file. A path to
 * take out, `null` when the file cannot be read (a refusal too), or
 * `undefined`. The gateway's check (`gateway/policy.ts`); in the panel the
 * session's rules on ADE's server come after it (B8d, `serve-rules.ts`).
 */
export function configGrant(text: string, identifier: string): string | null | undefined {
  const config = parseJsonc(text)
  if (!isMap(config)) return null
  const found = grantIn("permission", config["permission"], "permission") ?? grantIn("tools", config["tools"], "tools")
  if (found) return found
  for (const section of ["agent", "mode"]) {
    const agents = config[section]
    if (agents === undefined) continue
    if (!isMap(agents)) return section
    const agent = agents[identifier]
    if (agent === undefined) continue
    if (!isMap(agent)) return `${section}.${identifier}`
    const at = `${section}.${JSON.stringify(identifier)}`
    const own =
      grantIn("permission", agent["permission"], `${at}.permission`) ?? grantIn("tools", agent["tools"], `${at}.tools`)
    if (own) return own
  }
  return undefined
}
