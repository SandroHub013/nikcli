/**
 * Reading and writing bots where ragu keeps them.
 *
 * The rules are next door in `ragu.ts` and are pure; this is the part that
 * touches the machine — listing two directories, running `ragu agent
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
import { getHost, type Host, type RunResult } from "../host/shell"
import type { ProjectFs } from "./project-trust"
import { joinPath } from "../host/path"
import { SAFE_EFFORT, SAFE_MODEL } from "./runners"
import { isLegacyTalkKey, parseTalk, serializeTalk, talkKey, TALK_KEY_PREFIX, type Talk } from "./talk"
import { createGatewayThreads, type GatewayThreads } from "./gateway/threads"
import {
  agentHome,
  agentDirs,
  createArgs,
  editedAgentFile,
  globalConfigDir,
  globalConfigName,
  identifierFor,
  joinPrompt,
  launchArgs,
  RAGU_COMMAND,
  parseCreatedPath,
  parseModelList,
  projectConfigDir,
  readAgentFile,
  serializeAgentFile,
  type AgentFile,
  type AgentMode,
  type AgentScope,
} from "./ragu"
import { DOT_FOLDERS, folderExists, type Exists } from "./app-folder"

/** Where to look, and where to write. */
export interface BotRoots {
  /** The open project, when there is one. Bots here travel with the repository. */
  readonly project?: string
  /** ragu's global configuration directory. Bots here follow the user. */
  readonly global?: string
}

/**
 * The two places ragu discovers agents, resolved for this machine.
 *
 * The global one is derived from the home directory rather than read from the
 * environment, because ADE cannot see the environment of a process it has not
 * started — see `globalConfigDir`. A wrong guess costs a global roster that
 * lists nothing; it can never cause a write to the wrong place, because every
 * write goes to a path ragu itself printed or to the project.
 */
export async function resolveRoots(projectRoot?: string): Promise<BotRoots> {
  const host = await getHost()
  const home = await host?.homeDir?.()
  const platform = typeof navigator !== "undefined" && /win/i.test(navigator.userAgent ?? "") ? "windows" : "posix"

  return {
    ...(projectRoot ? { project: projectRoot } : {}),
    ...(home ? { global: globalConfigDir(home, platform, await globalConfigName(home, platform, hostFolders(host))) } : {}),
  }
}

/**
 * How deep to follow subdirectories under an agent folder.
 *
 * ragu's glob is `**`, which is unbounded; this is not, because ADE reads
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
       * ragu finds agents at any depth (`{agent,agents}/**\/*.md`), so a
       * roster that read only the top level would miss bots that ragu runs
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
       * One unreadable file must not empty the roster. ragu would refuse to
       * load it and say so on its own terms; here it is simply one bot that
       * does not appear, which is the same thing the user sees in ragu.
       */
      continue
    }
  }
}

/** The host's folders, for rule B (`app-folder.ts`). */
function hostFolders(host: Host | null | undefined): Exists {
  return folderExists(host?.readDir && ((path: string) => host.readDir!(path)))
}

/** A project's `.ragu` or `.nikcli`; nothing for the global scope, whose folder is the configuration itself. */
async function dotFolderOf(host: Host, base: string, scope: AgentScope): Promise<string | undefined> {
  return scope === "project" ? projectConfigDir(base, hostFolders(host)) : undefined
}

async function readScope(host: Host, base: string, scope: AgentScope): Promise<AgentFile[]> {
  const found: AgentFile[] = []
  // Both spellings, because ragu accepts both.
  for (const directory of agentDirs(base, scope, await dotFolderOf(host, base, scope))) {
    await readDirectory(host, directory, scope, 0, found)
  }
  return found
}

/**
 * Every bot this machine has, project ones first.
 *
 * Project before global because that is the order of specificity ragu itself
 * applies, and because a bot written for the repository you have open is the
 * one you meant. Same-named entries are not merged: they are two files, ragu
 * resolves the collision its own way, and hiding one of them here would make
 * the roster disagree with `ragu agent list`.
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
  /** What the bot is for. ragu writes the prompt from this when generating. */
  readonly description: string
  /** The persona, when the user wrote one. Empty means: let ragu write it. */
  readonly persona?: string
  /** `provider/model` as ragu names models, or nothing for its default. */
  readonly model?: string
  /** ragu's `variant`: how hard the model is asked to think. */
  readonly effort?: string
  /** What the bot is always working towards, beyond the persona. */
  readonly objectives?: readonly string[]
  readonly mode?: AgentMode
  /** Which tools it may use. Omitted means all of them. */
  readonly tools?: readonly string[]
  /** The face the user picked, `shape/color`. Omitted: the name decides. */
  readonly avatar?: string
  /** The program its turns run on (`runners.ts`). Omitted: ragu. */
  readonly runner?: string
}

export type CreateBotResult =
  | { readonly ok: true; readonly path: string; readonly identifier: string }
  | { readonly ok: false; readonly problem: string }

/**
 * Creates a bot, by whichever of the two routes the form asked for.
 *
 * **Generated** — the user described what they want and ragu's own model
 * writes the identifier, the "when to use" line and the system prompt. This is
 * `ragu agent create`, the native function, run non-interactively; it is the
 * reason the bot section is tied to ragu rather than keeping a roster of its
 * own.
 *
 * **Written** — the user typed the persona themselves. There is nothing for a
 * model to do, and paying for a generation to then throw its prompt away would
 * be worse than writing the same file directly. The file is byte-compatible
 * with the generated one: same directory, same frontmatter keys, so ragu
 * cannot tell them apart and neither can this roster.
 *
 * Either way the model is pinned afterwards, because `agent create` spends
 * `--model` on the model that *writes* the agent and never records one.
 */
export async function createBot(
  input: CreateBotInput,
  roots: BotRoots,
  hostOf: () => Promise<Host | undefined> = getHost,
): Promise<CreateBotResult> {
  const host = await hostOf()
  if (!host) return { ok: false, problem: t("bots.store.noHost") }

  const base = input.scope === "project" ? roots.project : roots.global
  if (!base) {
    return {
      ok: false,
      problem: input.scope === "project" ? t("bots.store.noProject") : t("bots.store.noGlobal"),
    }
  }

  const home = agentHome(base, input.scope, await dotFolderOf(host, base, input.scope))
  const mode: AgentMode = input.mode ?? "primary"

  if (input.persona && input.persona.trim().length > 0) {
    return writeBot({ ...input, mode, home, base }, host)
  }

  if (!host.raguBot) return { ok: false, problem: t("bots.store.noRagu") }
  /*
   * The name is the user's (bot-ui-3, 1): ragu writes the instructions, and the file is then kept under the name the
   * form was given, whatever ragu called it. Settled first, so a name already taken costs no generation.
   */
  const target = await newBotPath({ ...input, home, base }, host)
  if ("problem" in target) return { ok: false, problem: target.problem }
  const result = await host.raguBot(
    createArgs({
      home,
      description: input.description,
      mode,
      ...(input.tools ? { tools: input.tools } : {}),
      // The model that writes the file, so the cost named in the form is the one that runs.
      ...(input.model ? { model: input.model } : {}),
    }),
    base,
  )

  const created = parseCreatedPath(result.stdout)
  if (!created) {
    /*
     * Shown rather than summarised. This is the output of another program,
     * and the reasons it stops — no model configured, an agent by that name
     * already there, no network for the generation — are all sentences the
     * user can act on, while "creazione non riuscita" is not.
     */
    const said = [result.stderr.trim(), result.stdout.trim()].filter((part) => part.length > 0).join("\n")
    return {
      ok: false,
      problem: said || t("bots.store.raguExited", String(result.code ?? t("bots.store.unknownCode"))),
    }
  }

  /*
   * The settings ragu's generator does not write.
   *
   * `agent create` chooses the identifier, the description and the prompt, and
   * spends `--model` on the model that *writes* the agent rather than
   * recording one — so the pin, the effort and the standing objectives are
   * applied to the file it just produced. Everything it did write is carried
   * through untouched.
   */
  const settings = {
    // What it is for is the user's words, as the name is; ragu's own line is for its generator.
    ...(input.description.trim() ? { description: input.description.trim() } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.avatar ? { avatar: input.avatar } : {}),
    ...(input.runner && input.runner !== "ragu" ? { runner: input.runner } : {}),
    ...(input.objectives && input.objectives.length > 0 ? { objectives: input.objectives } : {}),
  }
  if (!host.readTextFile || !host.writeTextFile) {
    return { ok: true, path: created, identifier: identifierFromCreated(created) }
  }
  const same = samePath(created, target.path)
  let failure: string | null
  try {
    const read = await host.readTextFile(created)
    failure = await host.writeTextFile(target.path, editedAgentFile(read.text, settings))
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  if (same) {
    // The bot exists under its name and works on ragu's defaults; only these are missing, and the detail view says
    // plainly what a bot is set to.
    return { ok: true, path: created, identifier: identifierFromCreated(created) }
  }
  // ragu's own file goes either way: one bot, under the user's name, or none and the reason.
  await host.deleteBotFile?.(created).catch(() => null)
  if (failure) return { ok: false, problem: failure }
  return { ok: true, path: target.path, identifier: target.identifier }
}

/** One file, however its path is written: slashes either way, a drive letter in either case. */
function samePath(a: string, b: string): boolean {
  const key = (path: string) => path.replace(/\\/g, "/").toLowerCase()
  return key(a) === key(b)
}

/**
 * Where a bot named `name` is written: `agent/<identifier>.md` in its home, the name made a file name as it always is
 * (`identifierFor`), never over a file that is there.
 */
async function newBotPath(
  input: { readonly name: string; readonly scope: AgentScope; readonly home: string; readonly base: string },
  host: Host,
): Promise<{ readonly identifier: string; readonly path: string } | { readonly problem: string }> {
  const existing = await listBots(input.scope === "project" ? { project: input.base } : { global: input.base })
  const identifier = identifierFor(
    input.name,
    existing.map((bot) => bot.identifier),
  )
  // `agent`, not `agents`: ragu reads both but writes the first, and a
  // roster split across two spellings is one the user has to think about.
  const path = joinPath(input.home, "agent", `${identifier}.md`)
  /*
   * Refused rather than overwritten, which is also what `agent create` does:
   * a bot's file is its memory of how to behave, and silently replacing one
   * because two names collapsed to the same identifier is the kind of loss
   * nobody notices until the bot answers differently.
   */
  let there: boolean | undefined
  try {
    there = await host.exists?.(path)
  } catch (error) {
    // `path_exists` rejects when the check itself fails (a drive that does not answer, access denied). Not «absent»: that
    // would let the write below go over a file that may be there. Said, so the form does not stay busy for good (review of F7d, O1).
    return { problem: error instanceof Error ? error.message : String(error) }
  }
  if (there) return { problem: t("bots.alreadyExists", identifier) }
  return { identifier, path }
}

function identifierFromCreated(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  return name.replace(/\.md$/i, "")
}

export async function writeBot(
  input: CreateBotInput & { home: string; base: string; mode: AgentMode },
  host: Host,
): Promise<CreateBotResult> {
  if (!host.writeTextFile) {
    return { ok: false, problem: t("bots.store.noWrite") }
  }

  const target = await newBotPath(input, host)
  if ("problem" in target) return { ok: false, problem: target.problem }
  const { identifier, path } = target

  const failure = await host.writeTextFile(
    path,
    serializeAgentFile({
      description: input.description || t("bots.defaultDescription", input.name),
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
  /** `undefined` in the object goes back to ragu. */
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
  async home() {
    return (await getHost())?.homeDir?.()
  },
}

/**
 * Stops every gateway of a bot, takes its tokens out of the keychain and its
 * links out of the gateway's state, with who was authorized (`forget_bot`).
 */
export type ForgetGateways = (bot: string) => Promise<void>

const forgetGateways: ForgetGateways = async (bot) => {
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("gateway_forget_bot", { bot })
}

/**
 * Removes a bot's file. The roster is the directory, so this is the deletion.
 *
 * Its gateways go first: they stop, the tokens leave the keychain, and the
 * links go with who was authorized. Before, a bot deleted here went on
 * answering its chats until ADE closed, its tokens stayed in the keychain,
 * and a new bot at the same path inherited the senders. When they cannot be
 * cleared the file stays, and the card says why.
 */
export async function deleteBot(
  bot: AgentFile,
  forget: ForgetGateways = forgetGateways,
  hostOf: () => Promise<Host | undefined> = getHost,
): Promise<string | undefined> {
  const host = await hostOf()
  if (!host?.deleteBotFile) return t("bots.store.hostMissing")
  try {
    await forget(bot.path)
  } catch (error) {
    return t("bots.store.gatewayKept", error instanceof Error ? error.message : String(error))
  }
  /*
   * A command of its own, which deletes only a bot's file. This used to go
   * through `host.run("cmd", ["/c", "del", …])`, which `run` refuses — it runs
   * git and nothing else — so deleting a bot always failed.
   */
  return (await host.deleteBotFile(bot.path)) ?? undefined
}

/**
 * The models ragu can be pinned to, as ragu names them.
 *
 * Asked of ragu rather than taken from ADE's own chat list: those are
 * OpenRouter ids, and a bot runs inside ragu, which can only reach models it
 * has a provider configured for. Offering the wrong list would offer choices
 * that fail at launch with a message from another program.
 */
export async function listModels(cwd?: string, hostOf: () => Promise<Host | undefined> = getHost): Promise<string[]> {
  const host = await hostOf()
  if (!host) return []
  try {
    if (!host.raguBot) return []
    const result = await host.raguBot(["models"], cwd)
    return parseModelList(result.stdout)
  } catch {
    return []
  }
}

/**
 * One provider's catalog, with its prices (`ragu models <provider>
 * --verbose`), for `catalog.ts`; every provider's without one (`ragu
 * models --verbose`, the bot form's models). Empty when it cannot be read.
 */
export async function modelCatalogText(provider: string | undefined, cwd?: string): Promise<string> {
  const read = await readModelCatalog(provider, cwd)
  return read.ok ? read.text : ""
}

/**
 * The same read, with why it failed: the bot form said «serve ragu nel
 * PATH» for a ragu that was there and exited with an error, and for a host
 * that cannot run it (review 4, MEDIO 2). The reason is ragu's first line
 * of error, cut short, never its whole output.
 */
export async function readModelCatalog(
  provider: string | undefined,
  cwd?: string,
  hostOf: () => Promise<Host | undefined> = getHost,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }> {
  const host = await hostOf().catch(() => undefined)
  if (!host?.raguBot) return { ok: false, reason: t("bots.models.noHost") }
  let result: RunResult
  try {
    result = await host.raguBot(provider ? ["models", provider, "--verbose"] : ["models", "--verbose"], cwd)
  } catch {
    return { ok: false, reason: t("bots.models.notFound") }
  }
  if (result.code !== 0) {
    const detail = (result.stderr.split(/\r?\n/).find((line) => line.trim()) ?? "").trim().slice(0, 160)
    return { ok: false, reason: t("bots.models.exit", String(result.code ?? "?"), detail) }
  }
  if (!result.stdout.trim()) return { ok: false, reason: t("bots.models.empty") }
  return { ok: true, text: result.stdout }
}

/** What to run to open a session as this bot. */
export function botLaunch(bot: AgentFile): { agentId: string; command: string; args: string[] } | undefined {
  /*
   * The runner's own TUI, with as much of the bot as its flags can carry.
   * Claude Code takes the persona as an appended system prompt; Codex only the
   * model and effort.
   */
  switch (bot.runner) {
    // The model and effort of a bot file go on the line only in the shapes a turn allows (`runners.ts`,
    // B1): `effort` sits inside a TOML string in `-c`, and a quote there wrote a second setting (bots 7).
    case "claude": {
      const args: string[] = []
      if (bot.model && SAFE_MODEL.test(bot.model)) args.push("--model", bot.model)
      if (bot.effort && SAFE_EFFORT.test(bot.effort)) args.push("--effort", bot.effort)
      if (bot.prompt.trim()) args.push("--append-system-prompt", bot.prompt.trim())
      return { agentId: "claude-code", command: "claude", args }
    }
    case "codex": {
      const args: string[] = []
      if (bot.model && SAFE_MODEL.test(bot.model)) args.push("-m", bot.model)
      if (bot.effort && SAFE_EFFORT.test(bot.effort)) args.push("-c", `model_reasoning_effort="${bot.effort}"`)
      return { agentId: "codex", command: "codex", args }
    }
    default:
      return { agentId: "ragu", command: RAGU_COMMAND, args: launchArgs(bot.identifier, bot.model) }
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
 * ragu keeps a project's agents in `<root>/.nikcli/agent/` and also
 * `<root>/.nikcli/agents/` (`agentDirs`). The root is the part before that
 * segment. A path without it is a global bot: its folder is not a project.
 */
export function projectOfBotPath(path: string): string | undefined {
  const folded = path.replace(/\\/g, "/").toLowerCase()
  let at = -1
  for (const mark of DOT_FOLDERS.flatMap((dot) => [`/${dot}/agents/`, `/${dot}/agent/`])) {
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
