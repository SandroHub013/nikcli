/**
 * Reading and writing bots where nikcli keeps them.
 *
 * The rules are next door in `nikcli.ts` and are pure; this is the part that
 * touches the machine — listing two directories, running `nikcli agent
 * create`, writing a file, deleting one. Split that way because the argument
 * lists and the file format are worth checking without a filesystem, and
 * because everything here is a one-line call to the host facade that would
 * only make those checks need a desktop shell.
 *
 * Nothing in here caches. A bot is a file, the user can edit it in the editor
 * two panes away, and a roster held in memory would disagree with the tree
 * they are looking at.
 */

import { t } from "../i18n"
import { getHost, type Host } from "../host/shell"
import type { ProjectFs } from "./project-trust"
import { joinPath } from "../host/path"
import { isLegacyTalkKey, parseTalk, serializeTalk, talkKey, TALK_KEY_PREFIX, type Talk } from "./talk"
import { createGatewayThreads, type GatewayThreads } from "./gateway/threads"
import {
  agentDir,
  agentHome,
  agentDirs,
  createArgs,
  editedAgentFile,
  globalConfigDir,
  identifierFor,
  joinPrompt,
  launchArgs,
  NIKCLI_COMMAND,
  parseCreatedPath,
  parseModelList,
  readAgentFile,
  serializeAgentFile,
  type AgentFile,
  type AgentMode,
  type AgentScope,
} from "./nikcli"

/** Where to look, and where to write. */
export interface BotRoots {
  /** The open project, when there is one. Bots here travel with the repository. */
  readonly project?: string
  /** nikcli's global configuration directory. Bots here follow the user. */
  readonly global?: string
}

/**
 * The two places nikcli discovers agents, resolved for this machine.
 *
 * The global one is derived from the home directory rather than read from the
 * environment, because ADE cannot see the environment of a process it has not
 * started — see `globalConfigDir`. A wrong guess costs a global roster that
 * lists nothing; it can never cause a write to the wrong place, because every
 * write goes to a path nikcli itself printed or to the project.
 */
export async function resolveRoots(projectRoot?: string): Promise<BotRoots> {
  const host = await getHost()
  const home = await host?.homeDir?.()
  const platform =
    typeof navigator !== "undefined" && /win/i.test(navigator.userAgent ?? "") ? "windows" : "posix"

  return {
    ...(projectRoot ? { project: projectRoot } : {}),
    ...(home ? { global: globalConfigDir(home, platform) } : {}),
  }
}

/**
 * How deep to follow subdirectories under an agent folder.
 *
 * nikcli's glob is `**`, which is unbounded; this is not, because ADE reads
 * the tree one `readDir` call at a time and an unbounded walk over a folder
 * someone pointed at a large checkout would stall the panel. Three levels is
 * far past any real layout — `agent/team/review/senior.md` — and the cost of
 * being wrong is a bot missing from a list, not a broken bot.
 */
const MAX_AGENT_DEPTH = 3

async function readDirectory(
  host: Host,
  directory: string,
  scope: AgentScope,
  depth: number,
  found: AgentFile[],
): Promise<void> {
  if (!host.readDir || !host.readTextFile) return

  let entries
  try {
    entries = await host.readDir(directory)
  } catch {
    // No such directory. A user who has never made one is the common case,
    // not an error worth showing.
    return
  }

  for (const entry of entries) {
    const path = joinPath(directory, entry.name)
    if (entry.is_dir) {
      /*
       * nikcli finds agents at any depth (`{agent,agents}/**\/*.md`), so a
       * roster that read only the top level would miss bots that nikcli runs
       * — a bot that exists everywhere except in the list of bots.
       */
      if (depth < MAX_AGENT_DEPTH) await readDirectory(host, path, scope, depth + 1, found)
      continue
    }
    if (!entry.name.toLowerCase().endsWith(".md")) continue

    try {
      const read = await host.readTextFile(path)
      found.push(readAgentFile({ path, scope, text: read.text }))
    } catch {
      /*
       * One unreadable file must not empty the roster. nikcli would refuse to
       * load it and say so on its own terms; here it is simply one bot that
       * does not appear, which is the same thing the user sees in nikcli.
       */
      continue
    }
  }
}

async function readScope(host: Host, base: string, scope: AgentScope): Promise<AgentFile[]> {
  const found: AgentFile[] = []
  // Both spellings, because nikcli accepts both.
  for (const directory of agentDirs(base, scope)) {
    await readDirectory(host, directory, scope, 0, found)
  }
  return found
}

/**
 * Every bot this machine has, project ones first.
 *
 * Project before global because that is the order of specificity nikcli itself
 * applies, and because a bot written for the repository you have open is the
 * one you meant. Same-named entries are not merged: they are two files, nikcli
 * resolves the collision its own way, and hiding one of them here would make
 * the roster disagree with `nikcli agent list`.
 */
export async function listBots(roots: BotRoots): Promise<AgentFile[]> {
  const host = await getHost()
  if (!host) return []

  const project = roots.project ? await readScope(host, roots.project, "project") : []
  const global = roots.global ? await readScope(host, roots.global, "global") : []
  return [...project, ...global]
}

export interface CreateBotInput {
  readonly name: string
  readonly scope: AgentScope
  /** What the bot is for. nikcli writes the prompt from this when generating. */
  readonly description: string
  /** The persona, when the user wrote one. Empty means: let nikcli write it. */
  readonly persona?: string
  /** `provider/model` as nikcli names models, or nothing for its default. */
  readonly model?: string
  /** nikcli's `variant`: how hard the model is asked to think. */
  readonly effort?: string
  /** What the bot is always working towards, beyond the persona. */
  readonly objectives?: readonly string[]
  readonly mode?: AgentMode
  /** Which tools it may use. Omitted means all of them. */
  readonly tools?: readonly string[]
  /** The face the user picked, `shape/color`. Omitted: the name decides. */
  readonly avatar?: string
  /** The program its turns run on (`runners.ts`). Omitted: nikcli. */
  readonly runner?: string
}

export type CreateBotResult =
  | { readonly ok: true; readonly path: string; readonly identifier: string }
  | { readonly ok: false; readonly problem: string }

/**
 * Creates a bot, by whichever of the two routes the form asked for.
 *
 * **Generated** — the user described what they want and nikcli's own model
 * writes the identifier, the "when to use" line and the system prompt. This is
 * `nikcli agent create`, the native function, run non-interactively; it is the
 * reason the bot section is tied to nikcli rather than keeping a roster of its
 * own.
 *
 * **Written** — the user typed the persona themselves. There is nothing for a
 * model to do, and paying for a generation to then throw its prompt away would
 * be worse than writing the same file directly. The file is byte-compatible
 * with the generated one: same directory, same frontmatter keys, so nikcli
 * cannot tell them apart and neither can this roster.
 *
 * Either way the model is pinned afterwards, because `agent create` spends
 * `--model` on the model that *writes* the agent and never records one.
 */
export async function createBot(input: CreateBotInput, roots: BotRoots): Promise<CreateBotResult> {
  const host = await getHost()
  if (!host) return { ok: false, problem: t("bots.store.noHost") }

  const base = input.scope === "project" ? roots.project : roots.global
  if (!base) {
    return {
      ok: false,
      problem:
        input.scope === "project"
          ? t("bots.store.noProject")
          : t("bots.store.noGlobal"),
    }
  }

  const home = agentHome(base, input.scope)
  const mode: AgentMode = input.mode ?? "primary"

  if (input.persona && input.persona.trim().length > 0) {
    return writeBot({ ...input, mode, home, base }, host)
  }

  if (!host.nikcliBot) return { ok: false, problem: t("bots.store.noNikcli") }
  const result = await host.nikcliBot(createArgs({
    home,
    description: input.description,
    mode,
    ...(input.tools ? { tools: input.tools } : {}),
    // The model that writes the file, so the cost named in the form is the one that runs.
    ...(input.model ? { model: input.model } : {}),
  }), base)

  const created = parseCreatedPath(result.stdout)
  if (!created) {
    /*
     * Shown rather than summarised. This is the output of another program,
     * and the reasons it stops — no model configured, an agent by that name
     * already there, no network for the generation — are all sentences the
     * user can act on, while "creazione non riuscita" is not.
     */
    const said = [result.stderr.trim(), result.stdout.trim()].filter((part) => part.length > 0).join("\n")
    return { ok: false, problem: said || t("bots.store.nikcliExited", String(result.code ?? t("bots.store.unknownCode"))) }
  }

  /*
   * The settings nikcli's generator does not write.
   *
   * `agent create` chooses the identifier, the description and the prompt, and
   * spends `--model` on the model that *writes* the agent rather than
   * recording one — so the pin, the effort and the standing objectives are
   * applied to the file it just produced. Everything it did write is carried
   * through untouched.
   */
  const settings = {
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.avatar ? { avatar: input.avatar } : {}),
    ...(input.runner && input.runner !== "nikcli" ? { runner: input.runner } : {}),
    ...(input.objectives && input.objectives.length > 0 ? { objectives: input.objectives } : {}),
  }
  if (Object.keys(settings).length > 0 && host.readTextFile && host.writeTextFile) {
    try {
      const read = await host.readTextFile(created)
      await host.writeTextFile(created, editedAgentFile(read.text, settings))
    } catch {
      // The bot exists and works on nikcli's defaults; only these are missing,
      // and the detail view says plainly what a bot is set to.
    }
  }

  return { ok: true, path: created, identifier: identifierFromCreated(created) }
}

function identifierFromCreated(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  return name.replace(/\.md$/i, "")
}

async function writeBot(
  input: CreateBotInput & { home: string; base: string; mode: AgentMode },
  host: Host,
): Promise<CreateBotResult> {
  if (!host.writeTextFile) {
    return { ok: false, problem: t("bots.store.noWrite") }
  }

  const existing = await listBots(
    input.scope === "project" ? { project: input.base } : { global: input.base },
  )
  const identifier = identifierFor(input.name, existing.map((bot) => bot.identifier))
  // `agent`, not `agents`: nikcli reads both but writes the first, and a
  // roster split across two spellings is one the user has to think about.
  const path = joinPath(agentDir(input.base, input.scope), `${identifier}.md`)

  /*
   * Refused rather than overwritten, which is also what `agent create` does:
   * a bot's file is its memory of how to behave, and silently replacing one
   * because two names collapsed to the same identifier is the kind of loss
   * nobody notices until the bot answers differently.
   */
  if (await host.exists?.(path)) {
    return { ok: false, problem: `Esiste già un bot con identificativo «${identifier}».` }
  }

  const failure = await host.writeTextFile(
    path,
    serializeAgentFile({
      description: input.description || `Bot «${input.name}».`,
      mode: input.mode,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.avatar ? { avatar: input.avatar } : {}),
      ...(input.runner ? { runner: input.runner } : {}),
      prompt: joinPrompt({
        persona: input.persona ?? "",
        objectives: input.objectives ?? [],
      }),
    }),
  )
  if (failure) return { ok: false, problem: failure }

  return { ok: true, path, identifier }
}

export interface BotChanges {
  readonly description?: string
  /** `undefined` in the object clears the pin; omit the key to leave it alone. */
  readonly model?: string | undefined
  readonly effort?: string | undefined
  readonly persona?: string
  readonly objectives?: readonly string[]
  /** `undefined` in the object goes back to the face the name gives. */
  readonly avatar?: string | undefined
  /** `undefined` in the object goes back to nikcli. */
  readonly runner?: string | undefined
}

/**
 * Changes a bot's settings, in its own file.
 *
 * Read, rewrite, write back — rather than patch — because the file is YAML
 * plus prose and a targeted edit on either half is how you get two `model:`
 * keys or a heading inside a sentence. The read is fresh every time for the
 * same reason the roster is: the user can have the file open in the editor
 * two panes away, and writing back a copy loaded minutes ago would silently
 * revert whatever they typed there.
 */
export async function updateBot(bot: AgentFile, changes: BotChanges): Promise<string | undefined> {
  const host = await getHost()
  if (!host?.readTextFile || !host.writeTextFile) return t("bots.store.noWrite")

  try {
    const read = await host.readTextFile(bot.path)
    return (await host.writeTextFile(bot.path, editedAgentFile(read.text, changes))) ?? undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** A bot's file as it is on disk now: what the trust in `trust.ts` is given to. */
export async function readBotText(path: string): Promise<string> {
  const host = await getHost()
  if (!host?.readTextFile) throw new Error(t("bots.store.noRead"))
  return (await host.readTextFile(path)).text
}

/**
 * The project's files, as `project-trust.ts` reads them. A host that cannot
 * list or read files throws, and such a host cannot start a turn either.
 */
export const projectFs: ProjectFs = {
  async readDir(path) {
    const host = await getHost()
    if (!host?.readDir) throw new Error(t("bots.store.noDir"))
    return host.readDir(path)
  },
  async readText(path) {
    const host = await getHost()
    if (!host?.readTextFile) throw new Error(t("bots.store.noRead"))
    return host.readTextFile(path)
  },
}

/** Removes a bot's file. The roster is the directory, so this is the deletion. */
export async function deleteBot(bot: AgentFile): Promise<string | undefined> {
  const host = await getHost()
  if (!host?.deleteBotFile) return t("bots.store.hostMissing")
  /*
   * A command of its own, which deletes only a bot's file. This used to go
   * through `host.run("cmd", ["/c", "del", …])`, which `run` refuses — it runs
   * git and nothing else — so deleting a bot always failed.
   */
  return (await host.deleteBotFile(bot.path)) ?? undefined
}

/**
 * The models nikcli can be pinned to, as nikcli names them.
 *
 * Asked of nikcli rather than taken from ADE's own chat list: those are
 * OpenRouter ids, and a bot runs inside nikcli, which can only reach models it
 * has a provider configured for. Offering the wrong list would offer choices
 * that fail at launch with a message from another program.
 */
export async function listModels(cwd?: string, hostOf: () => Promise<Host | undefined> = getHost): Promise<string[]> {
  const host = await hostOf()
  if (!host) return []
  try {
    if (!host.nikcliBot) return []
    const result = await host.nikcliBot(["models"], cwd)
    return parseModelList(result.stdout)
  } catch {
    return []
  }
}

/**
 * One provider's catalog, with its prices (`nikcli models <provider>
 * --verbose`), for `catalog.ts`. Empty when it cannot be read.
 */
export async function modelCatalogText(provider: string, cwd?: string): Promise<string> {
  const host = await getHost()
  if (!host?.nikcliBot) return ""
  try {
    const result = await host.nikcliBot(["models", provider, "--verbose"], cwd)
    return result.code === 0 ? result.stdout : ""
  } catch {
    return ""
  }
}

/** What to run to open a session as this bot. */
export function botLaunch(bot: AgentFile): { agentId: string; command: string; args: string[] } | undefined {
  /*
   * The runner's own TUI, with as much of the bot as its flags can carry.
   * Claude Code takes the persona as an appended system prompt; Codex only the
   * model and effort.
   */
  switch (bot.runner) {
    case "claude": {
      const args: string[] = []
      if (bot.model) args.push("--model", bot.model)
      if (bot.effort) args.push("--effort", bot.effort)
      if (bot.prompt.trim()) args.push("--append-system-prompt", bot.prompt.trim())
      return { agentId: "claude-code", command: "claude", args }
    }
    case "codex": {
      const args: string[] = []
      if (bot.model) args.push("-m", bot.model)
      if (bot.effort) args.push("-c", `model_reasoning_effort="${bot.effort}"`)
      return { agentId: "codex", command: "codex", args }
    }
    default:
      return { agentId: "nikcli", command: NIKCLI_COMMAND, args: launchArgs(bot.identifier, bot.model) }
  }
}

/**
 * The thread archive (B4).
 *
 * One entry per bot and project, written when a burst of lines stops or the
 * turn ends — not on every line, which rewrote the whole thread for each
 * token of tool output. The bytes are whatever disk the caller has; the panel
 * uses the WebView's localStorage, which is that disk.
 */
/** The gateway chats' threads, in the renderer's storage, one key per bot, platform and chat. */
export function localGatewayThreads(): GatewayThreads {
  return createGatewayThreads({
    getItem: (key) => {
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    },
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  })
}

export interface TalkDisk {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
  keys?(): readonly string[]
}

function quotaExceeded(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const name = "name" in error ? String(error.name) : ""
  const code = "code" in error ? Number(error.code) : 0
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22 || code === 1014
}

function updatedAtOf(raw: string | null): number {
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw) as { updatedAt?: unknown }
    return typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0
  } catch {
    return 0
  }
}

/** Drops the least recently updated thread keys, not `except`. One generation, so a retry has room. */
function dropOldestTalks(disk: TalkDisk, except: string): boolean {
  if (!disk.keys || !disk.removeItem) return false
  const ranked = disk
    .keys()
    .filter((key) => key.startsWith(TALK_KEY_PREFIX) && key !== except)
    .map((key) => ({ key, at: updatedAtOf(disk.getItem(key)) }))
    .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
  const oldest = ranked[0]
  if (!oldest) return false
  for (const item of ranked) {
    if (item.at !== oldest.at) break
    disk.removeItem(item.key)
  }
  return true
}

/**
 * The project a bot file belongs to, from the path alone.
 *
 * nikcli keeps a project's agents in `<root>/.nikcli/agent/` and also
 * `<root>/.nikcli/agents/` (`agentDirs`). The root is the part before that
 * segment. A path without it is a global bot: its folder is not a project.
 */
export function projectOfBotPath(path: string): string | undefined {
  const folded = path.replace(/\\/g, "/").toLowerCase()
  let at = -1
  for (const mark of ["/.nikcli/agents/", "/.nikcli/agent/"]) {
    const found = folded.lastIndexOf(mark)
    if (found > at) at = found
  }
  if (at <= 0) return undefined
  const root = path.slice(0, at).replace(/[\\/]+$/, "")
  return root.length > 0 ? root : undefined
}

/**
 * Once, even when no project is open.
 *
 * Threads saved as `ade.bots.talk:<path>` filled the quota and are never read
 * again. A project bot's root comes from its path, so a thread from another
 * project is not filed under the one open now. A global bot, a path without
 * that segment, moves under the open project (or "" when none is open),
 * without its session id. The old key is removed before the new one is
 * written: at a full quota the delete is what makes the write fit.
 */
export function migrateTalkKeys(disk: TalkDisk, openProject: string): void {
  if (!disk.keys || !disk.removeItem) return
  const legacy = disk.keys().filter(isLegacyTalkKey)
  for (const key of legacy) {
    const path = key.slice(TALK_KEY_PREFIX.length)
    let raw: string | null = null
    try {
      raw = disk.getItem(key)
    } catch {
      raw = null
    }
    try {
      disk.removeItem(key)
    } catch {
      // Still try to write what was read. The old key staying is the worse miss.
    }
    try {
      const talk = parseTalk(raw)
      const root = projectOfBotPath(path)
      if (root) {
        disk.setItem(talkKey(path, root), serializeTalk(talk))
      } else {
        const { sessionId: _gone, ...rest } = talk
        disk.setItem(talkKey(path, openProject), serializeTalk(rest))
      }
    } catch {
      // The old key is already gone. A write that does not fit loses this thread.
    }
  }
}

export function createTalkArchive(
  disk: TalkDisk,
  waitMs = 400,
  later: (run: () => void, ms: number) => () => void = (run, ms) => {
    const id = setTimeout(run, ms)
    return () => clearTimeout(id)
  },
) {
  const pending = new Map<string, () => void>()
  const write = (key: string, value: string) => {
    try {
      disk.setItem(key, value)
    } catch (error) {
      // One retry after the oldest threads are dropped. A second failure stays lost for this session.
      if (!quotaExceeded(error) || !dropOldestTalks(disk, key)) return
      try {
        disk.setItem(key, value)
      } catch {
        // Still over the quota. The thread on screen is unchanged.
      }
    }
  }
  return {
    read(key: string): Talk {
      try {
        return parseTalk(disk.getItem(key))
      } catch {
        return parseTalk(null)
      }
    },
    /** Remembers the latest thread and writes it once the lines stop arriving. */
    save(key: string, talk: Talk): void {
      const value = serializeTalk(talk)
      pending.get(key)?.()
      const cancel = later(() => {
        pending.delete(key)
        write(key, value)
      }, waitMs)
      pending.set(key, cancel)
    },
    /** Writes now. A turn that ended, or a conversation that was forgotten. */
    flush(key: string, talk: Talk): void {
      pending.get(key)?.()
      pending.delete(key)
      write(key, serializeTalk(talk))
    },
  }
}
