/**
 * Whether a bot from the open project may run (B3, audit A4).
 *
 * A bot in the project's `.nikcli/agent/` is a file the repository's author
 * wrote: a cloned repository can bring one, with a persona and settings
 * meant to do something the user never asked for. It runs on the user's own
 * plan, in the user's folder. So the first time it is used the user is asked,
 * and the answer holds for that exact file: the SHA-256 of its contents. When
 * the file changes, the question comes back. The user's own bots (global
 * scope) are never asked about.
 *
 * What a trusted repository bot may do is still less than one the user wrote:
 * see `fromRepository` in `runners.ts`.
 */

import { parseAgentFile, type AgentFile } from "./nikcli"
import { canWrite, runnerById } from "./runners"
import { t } from "../i18n"

/** The trusted fingerprint of each file, by path. */
export interface TrustStore {
  get: (path: string) => string | undefined
  set: (path: string, fingerprint: string) => void
}

const STORAGE_KEY = "ade.bots.trusted"

/**
 * In the renderer's storage: a trust given on this machine, by this user.
 * Bots under one key, projects (`project-trust.ts`) under another.
 */
export function localTrustStore(key: string = STORAGE_KEY): TrustStore {
  const read = (): Record<string, string> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
    } catch {
      return {}
    }
  }
  return {
    get: (path) => {
      const value = read()[path]
      return typeof value === "string" ? value : undefined
    },
    set: (path, fingerprint) => {
      try {
        localStorage.setItem(key, JSON.stringify({ ...read(), [path]: fingerprint }))
      } catch {
        // Storage blocked: the trust lasts until the file is asked about again.
      }
    },
  }
}

/** For tests, and wherever nothing should outlive the process. */
export function memoryTrustStore(): TrustStore {
  const trusted = new Map<string, string>()
  return { get: (path) => trusted.get(path), set: (path, fingerprint) => void trusted.set(path, fingerprint) }
}

/** SHA-256 of `text`, in hex. */
export async function fileFingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/*
 * Tools a bot file may leave to run unasked. Everything else — the shell,
 * edits, the web, other folders, sub-agents, `*` and any per-command pattern
 * — is a grant the repository's author gave the bot, not the user.
 */
const SAFE_TO_ALLOW = new Set(["read", "grep", "glob", "list", "todoread", "todowrite", "lsp", "skill"])

const unquoteKey = (key: string) => key.replace(/^(["'])(.*)\1$/, "$2")

/*
 * `key: allow` (for `permission`) or `key: true` (for the older `tools`, which
 * nikcli turns into `allow`), in block or flow form, the key bare or quoted,
 * and a YAML tag before the value allowed for.
 */
const GRANT = (value: string) =>
  new RegExp(`(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_*./-]+))\\s*:\\s*(?:!\\S*\\s+)?["']?${value}["']?(?![A-Za-z0-9_])`, "gi")

/** One grant a bot file gives itself: what, under which permission, and the line that says it. */
export interface Grant {
  /** The key granted: a tool, a pattern, `*`, or the frontmatter key when it cannot be read. */
  readonly what: string
  /** The permission it falls under (`bash` for `bash: { "git *": allow }`); `*` when unknown. */
  readonly under: string
  /** The line of the file that grants it, as written. */
  readonly line: string
}

const LEADING_KEY = /^\s*(?:"([^"]*)"|'([^']*)'|([^\s:{},"']+))\s*:/

/*
 * Brace depth at each position of `value`, quotes skipped: a flow map's `{`
 * and `}` in the frontmatter, never one inside a quoted key.
 */
function depthBefore(value: string, end: number): { depth: number; segment: number } {
  let depth = 0
  let quote: string | undefined
  // Where the current entry of the outermost flow map starts.
  let segment = 0
  for (let index = 0; index < end; index++) {
    const char = value[index]
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "{") {
      depth++
      if (depth === 1) segment = index + 1
    } else if (char === "}") depth--
    else if (char === "," && depth === 1) segment = index + 1
  }
  return { depth, segment }
}

/*
 * The permission a grant at `index` of `value` (what follows `permission:`)
 * falls under. A flow map (`{ bash: { "git *": allow } }`) by its braces; a
 * block by the least indented line at or above it that is outside any
 * braces. `undefined` when it cannot be told, which the caller counts as `*`.
 */
function topKeyAt(value: string, index: number): string | undefined {
  const firstLine = value.split("\n")[0] ?? ""
  if (firstLine.trim().startsWith("{")) {
    const { depth, segment } = depthBefore(value, index)
    if (depth < 1) return undefined
    const key = LEADING_KEY.exec(value.slice(segment))
    return key ? unquoteKey(key[1] ?? key[2] ?? key[3] ?? "") : undefined
  }
  const starts: number[] = []
  for (let at = value.indexOf("\n"); at !== -1; at = value.indexOf("\n", at + 1)) starts.push(at + 1)
  const content = starts.filter((start) => {
    const line = value.slice(start, value.indexOf("\n", start) === -1 ? undefined : value.indexOf("\n", start))
    return line.trim().length > 0 && !line.trimStart().startsWith("#")
  })
  const indentOf = (start: number) => /^[ \t]*/.exec(value.slice(start))![0].length
  const least = Math.min(...content.map(indentOf))
  const candidates = content.filter((start) => start <= index && indentOf(start) === least && depthBefore(value, start).depth === 0)
  const top = candidates.at(-1)
  if (top === undefined) return undefined
  const key = LEADING_KEY.exec(value.slice(top))
  return key ? unquoteKey(key[1] ?? key[2] ?? key[3] ?? "") : undefined
}

/**
 * Every grant a bot file gives itself that nikcli would honour without asking
 * (review B3, A2; B8c). nikcli reads the file itself, frontmatter included, so
 * a bot with `permission: { bash: allow }` runs commands nobody is asked
 * about. Deliberately strict: a grant this cannot read for certain — an
 * alias, a merge key, another frontmatter language — counts as one, under `*`.
 */
export function grantsIn(text: string): Grant[] {
  // gray-matter drops a byte-order mark before looking for `---`; so does this.
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
  // `---json`, `---yaml` and the like: gray-matter reads them, this does not.
  if (/^---[^\n-]/.test(normalized)) return [{ what: "---", under: "*", line: normalized.split("\n")[0] ?? "---" }]
  const grants: Grant[] = []
  for (const [rawKey, lines] of Object.entries(parseAgentFile(normalized).front.raw)) {
    const key = unquoteKey(rawKey.trim())
    if (key !== "permission" && key !== "tools") continue
    const body = lines.join("\n")
    const start = body.indexOf(":") + 1
    const value = body.slice(start)
    const lineAt = (index: number) => {
      const from = body.lastIndexOf("\n", start + index - 1) + 1
      const to = body.indexOf("\n", start + index)
      return body.slice(from, to === -1 ? undefined : to).trim()
    }
    const alias = /:\s*[*&][A-Za-z]|<<\s*:|^[ \t]*[*&][A-Za-z]/m.exec(value)
    if (alias) {
      grants.push({ what: key, under: "*", line: lineAt(alias.index) })
      continue
    }
    if (key === "permission" && /^\s*(?:!\S*\s+)?["']?allow["']?\s*$/i.test(value.split("\n")[0] ?? "")) {
      grants.push({ what: "*", under: "*", line: lineAt(0) })
      continue
    }
    for (const match of value.matchAll(GRANT(key === "permission" ? "allow" : "true"))) {
      const what = match[1] ?? match[2] ?? match[3] ?? ""
      grants.push({ what, under: topKeyAt(value, match.index) ?? "*", line: lineAt(match.index) })
    }
  }
  return grants
}

/**
 * What a bot file grants itself beyond the tools it may leave unasked
 * (`SAFE_TO_ALLOW`), or `undefined`: a project's bot with any such grant does
 * not start (review B3, A2).
 */
export function selfApproval(text: string): string | undefined {
  return grantsIn(text).find((grant) => !SAFE_TO_ALLOW.has(grant.what))?.what
}

/** `*` and `?` as nikcli's `Wildcard.match` reads them in a permission's name. */
function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "s")
}

/**
 * Whether a grant under `permission` reaches what ADE asks about for a bot in
 * the panel (`bot-ask-shell` in `runners.ts`): the shell, or a folder outside
 * the project. nikcli merges the bot's own rules after `NIKCLI_PERMISSION`,
 * and the last matching rule wins, so such a grant is a command no one is
 * asked about, the block list included.
 */
export function reachesShell(permission: string): boolean {
  const name = wildcard(permission)
  return name.test("bash") || name.test("external_directory")
}

/**
 * The line of a bot file that grants the shell or a folder outside, or
 * `undefined`: a nikcli bot with one does not start from the panel (B8c), the
 * user's own included, and the message names the line to take out.
 */
export function shellGrant(text: string): Grant | undefined {
  return grantsIn(text).find((grant) => reachesShell(grant.under))
}

/** Project bots with a question on screen, so a second send does not ask again (review B3, BASSO 1). */
const asking = new Set<string>()

export interface AdmitDeps {
  readonly store: TrustStore
  /** The bot file's contents as they are now. */
  readonly read: (path: string) => Promise<string>
  /** Asks the user; true is yes. */
  readonly confirm: (question: string) => boolean | Promise<boolean>
}

/**
 * Whether `bot` may take a turn now. A user's bot always may; a project's
 * bot may once its file, as it is now, was trusted — asked here when it was
 * not, and remembered on a yes.
 */
export async function admit(bot: AgentFile, deps: AdmitDeps): Promise<{ ok: true } | { ok: false; problem?: string }> {
  if (bot.scope !== "project") return { ok: true }
  if (asking.has(bot.path)) return { ok: false }
  let text: string
  try {
    text = await deps.read(bot.path)
  } catch {
    return { ok: false, problem: t("bots.trust.unreadable", bot.identifier) }
  }
  const runner = runnerById(bot.runner).id
  // Checked on every turn, trusted or not: nikcli reads the file as it is now.
  const granted = runner === "nikcli" ? grantsIn(text).find((grant) => !SAFE_TO_ALLOW.has(grant.what)) : undefined
  if (granted !== undefined)
    return { ok: false, problem: t("bots.trust.selfApproves", bot.identifier, granted.what, granted.line) }
  const fingerprint = await fileFingerprint(text)
  const trusted = deps.store.get(bot.path)
  if (trusted === fingerprint) return { ok: true }
  const can = t(
    runner === "codex"
      ? "bots.trust.can.codex"
      : runner === "claude"
        ? canWrite(bot)
          ? "bots.trust.can.claude"
          : "bots.trust.can.claudeReadOnly"
        : "bots.trust.can.nikcli",
  )
  const question =
    trusted === undefined ? t("bots.trust.new", bot.identifier, can) : t("bots.trust.changed", bot.identifier, can)
  asking.add(bot.path)
  try {
    if (!(await deps.confirm(question))) return { ok: false }
  } catch {
    // A question that cannot be put is a no, said on screen: otherwise the
    // message comes back with no word of why (B7, live in ADE).
    return { ok: false, problem: t("bots.ask.failed", bot.identifier) }
  } finally {
    asking.delete(bot.path)
  }
  deps.store.set(bot.path, fingerprint)
  return { ok: true }
}
