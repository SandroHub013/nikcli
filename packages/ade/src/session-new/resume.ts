import { LIST_MS, type Timers } from "./ask-cli"
import { folderKey, sameFolder } from "./folder"
import { isBotSession } from "../bots/serve-rules"

/**
 * Bringing a session back, and not just a pane that looks like one.
 *
 * A pty is a child of this window: closing ADE kills every agent, and a
 * machine restart kills everything. What ADE restored until now was the pane
 * and the task — it started the agent again and typed the prompt in, which
 * opens a *new* conversation that happens to share a title. Everything the
 * agent had worked out was gone, and nothing said so.
 *
 * The agents themselves keep their conversations on disk and can be told to
 * pick one up again. Two different shapes, and the difference decides what
 * ADE can promise:
 *
 *   pinned  — ADE has the id before the agent starts, hands it over on the
 *             command line, writes it down, and asks for that exact
 *             conversation back. Two sessions in one directory stay two
 *             conversations. The id is either one ADE invented (`start`) or
 *             one the CLI was asked for first (`mint`).
 *   last    — the agent will only offer "the most recent one here". Good
 *             enough for the common case of one session per project, and
 *             wrong the moment there are two, so only the first pane in a
 *             directory may use it.
 *
 * The table below is read off `--help` of each CLI rather than remembered.
 * An agent that is not in it restores the way it always did: started fresh,
 * with the task typed in. That is a worse restore, not a broken one, and it
 * is what every agent gets until someone checks its flags.
 */

/** What one CLI offers. Absent fields mean "this CLI cannot do that". */
export interface ResumeRecipe {
  /**
   * Arguments that start a new conversation under an id ADE picked.
   *
   * Only declared where `byId` exists too: an id ADE cannot ask for again is
   * a value written down for nothing.
   */
  readonly start?: (id: string) => string[]
  /** Arguments that reopen exactly that conversation. */
  readonly byId?: (id: string) => string[]
  /** Arguments that reopen the most recent conversation in this directory. */
  readonly last?: () => string[]
  /**
   * A command that lists this directory's conversations, for a CLI whose own
   * "most recent" is not this directory's.
   *
   * nikcli is the case: `--continue` takes the latest conversation of the
   * whole project, and a git project spans every worktree of the repository,
   * so a pane came back inside another worktree's conversation. `nikcli api
   * session.list` filters by directory on the server; ADE reads the first
   * one no other pane holds and opens it with `byId`. When there is none, or
   * the command does not answer, a new conversation is asked for (`mint`):
   * an empty one is better than someone else's.
   *
   * Run under a pty like `mint`, and like `mint` the command may print and
   * never exit (inside a git repository), so `read` is called on what has
   * arrived so far: an id, `null` when the list is complete and has none,
   * `undefined` while it is still coming.
   */
  readonly lastHere?: {
    readonly args: (cwd: string) => string[]
    readonly read: (output: string, cwd: string, taken: ReadonlySet<string>, marks?: readonly string[]) => string | null | undefined
  }
  /**
   * A command that asks the CLI itself for a new conversation, for a CLI that
   * refuses an id ADE invented.
   *
   * nikcli is the case this exists for: `--session <id>` only *continues* a
   * conversation and fails on an id it has never seen, so ADE cannot make one
   * up. It can ask: `nikcli api session.create` writes the new conversation —
   * with the directory it was run in — and prints it, id first. ADE reads the
   * id, kills that short-lived command and starts the real session with
   * `--session <id>`. From then on the pane is pinned like Claude Code's.
   *
   * The command is run under a pty like any other, so `read` is given
   * whatever reached the screen, not a clean stdout.
   */
  readonly mint?: {
    readonly args: (title: string) => string[]
    /** The id in what the command printed, or undefined when it printed none. */
    readonly read: (output: string) => string | undefined
  }
  /**
   * How to ask the CLI whether the conversation `byId` would reopen is still
   * there, for a CLI that keeps no transcript file to look for.
   *
   * nikcli is the case: its conversations are rows in one database, and one
   * deleted from nikcli made the pane's `--session <id>` fail on the next
   * restart (Verifiche, 2026-09-27: the raw `NotFoundError`, then «Uscito con
   * 1»). Asked first, a missing one is a new conversation instead.
   */
  readonly exists?: {
    readonly args: (id: string) => string[]
    /** `gone`, `here`, or undefined while the answer has not arrived. */
    readonly read: (output: string, id: string) => "gone" | "here" | undefined
  }
  /**
   * Arguments that start a new conversation as a copy of `parent`, under
   * `child` where the CLI takes an id. The copy's prompt is the parent's, so a
   * forked subagent reads the parent's context from the cache instead of
   * paying for it again.
   *
   *   claude  --resume <parent> --fork-session --session-id <child>
   *   codex   fork <parent>
   */
  readonly fork?: (parent: string, child: string) => string[]
  /**
   * Where the CLI keeps the conversation `byId` would reopen.
   *
   * A pinned id is written down before the agent has said a word, and the CLI
   * only writes the conversation once there is something in it. A session
   * opened and closed without a message leaves an id that `--resume` answers
   * with "No conversation found" — and the CLI then opens a new conversation
   * under an id nobody recorded, so the next restore fails the same way.
   * Undefined when the location is not known: the id is then trusted.
   */
  readonly transcript?: (home: string, cwd: string, id: string) => string | undefined
  /**
   * A file where the CLI itself records the latest conversation per directory.
   *
   * The way to learn an id for a CLI that will not take one up front: read it
   * when the session starts, read it again while it runs, and an id that
   * appears in between is the one this session opened.
   */
  readonly latest?: {
    readonly path: (home: string) => string
    readonly read: (text: string, cwd: string) => string | undefined
  }
}

function joinHome(home: string, ...segments: string[]): string {
  const sep = home.includes("\\") ? "\\" : "/"
  return [home.replace(/[\\/]+$/, ""), ...segments].join(sep)
}

/**
 * agy's `cache/last_conversations.json`: `{ "<directory>": "<conversation id>" }`,
 * read off this machine. Conversations live in `conversations/<id>.db`.
 */
function agyLatest(text: string, cwd: string): string | undefined {
  let map: unknown
  try {
    map = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined
  for (const [dir, id] of Object.entries(map)) {
    if (typeof id === "string" && id && sameFolder(dir, cwd)) return id
  }
  return undefined
}

/**
 * The id `nikcli api session.create` printed.
 *
 * Read with a pattern rather than `JSON.parse`: the command runs under a pty,
 * so what comes back can carry escape sequences, carriage returns and a
 * warning line above the JSON. The id's own shape (`ses_` and base62) is
 * distinctive enough to be found in that, and anything else is refused.
 */
export function mintedNikcliId(output: string): string | undefined {
  const match = /"id"\s*:\s*"(ses_[A-Za-z0-9]{8,64})"/.exec(output)
  return match?.[1]
}

/**
 * Whether `nikcli api session.get` found the conversation `id`.
 *
 * A missing one is a 404 and `{"name":"NotFoundError", … "Session not found:
 * <id>"}`, and the command exits; a present one is the conversation's JSON,
 * after which the command stays up (`askCli` kills it once this answers).
 * Anything else — a warning, half a line — is no answer yet, and no answer at
 * all leaves the pane reopening the id as before.
 */
export function nikcliConversationThere(output: string, id: string): "gone" | "here" | undefined {
  const text = output.replace(/\r/g, "")
  if (/"name"\s*:\s*"NotFoundError"/.test(text) && text.includes(`Session not found: ${id}`)) return "gone"
  const found = /"id"\s*:\s*"(ses_[A-Za-z0-9]{8,64})"/.exec(text)
  return found?.[1] === id ? "here" : undefined
}

/**
 * The end of the title ADE gives a conversation it mints for a pane, which
 * says the pane it was asked for: panes are often all called "Sessione 1 —
 * nikcli", and inside the CLI the conversations are listed together.
 */
export function mintMark(paneId: string): string {
  return ` · ${paneId.slice(-8)}`
}

/**
 * The most recent root conversation of `cwd` in what `nikcli api
 * session.list` printed, leaving out the ones in `taken` and the ones whose
 * title ends with one of `marks`.
 *
 * `marks` are the other open panes' (`mintMark`): a conversation minted for
 * one of them is that pane's even when it does not hold the id. That is the
 * case of a mint past `MINT_MS` (`ask-cli.ts`): the command is killed, nikcli may have
 * written the conversation anyway, and ADE never read its id. Empty and the
 * newest of the folder, it was the other pane's "here" (review of
 * ripristino-quater, BASSO 2). `session.list` says nothing of a
 * conversation's messages, so the title is what tells it.
 *
 * The list is a pretty-printed JSON array, most recent first; it is parsed
 * only once it is whole, which is what tells a list still arriving from an
 * empty one. Each entry is checked again for its directory, its parent and
 * the shape of its id, so a server that ignored the filter would still not
 * hand over another folder's conversation.
 */
export function lastNikcliHere(
  output: string,
  cwd: string,
  taken: ReadonlySet<string>,
  marks: readonly string[] = [],
): string | null | undefined {
  const text = output.replace(/\r/g, "")
  // A line that is the array opening, not a "[warn] …" above it.
  const start = text.search(/^\[(?:\]|[ \t]*$)/m)
  if (start < 0) return undefined
  /*
   * And the line that closes it: `[]`, or the first `]` at the start of a
   * line after it (pretty-printed, the ones inside are indented). Not the
   * last `]` of the output: a "[warn] …" line after the list would move it.
   */
  const closing = text.startsWith("[]", start) ? start : text.slice(start).search(/^\]/m)
  if (closing < 0) return undefined
  const end = text.startsWith("[]", start) ? start + 1 : start + closing
  let list: unknown
  try {
    list = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  const updated = (entry: Record<string, unknown>) => {
    const time = entry["time"] as Record<string, unknown> | undefined
    return typeof time?.["updated"] === "number" ? time["updated"] : 0
  }
  const mine = list
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .filter(
      (entry) =>
        typeof entry["id"] === "string" &&
        /^ses_[A-Za-z0-9]{8,64}$/.test(entry["id"]) &&
        !entry["parentID"] &&
        // A bot's conversation is the bot's, however recent: not a pane's to take.
        !isBotSession(entry) &&
        typeof entry["directory"] === "string" &&
        sameFolder(entry["directory"], cwd) &&
        !taken.has(entry["id"]) &&
        !(typeof entry["title"] === "string" && marks.some((mark) => (entry["title"] as string).endsWith(mark))),
    )
    .sort((a, b) => updated(b) - updated(a))
  return (mine[0]?.["id"] as string | undefined) ?? null
}

/**
 * How many of the folder's most recent conversations `session.list` returns.
 * Not 5: bots' conversations and the ones other panes hold are left out here,
 * after the server has counted them, and five taken ones would hide the
 * pane's own.
 */
export const LAST_HERE_LIMIT = 50

/** The width of the terminal `session.list` and `session.create` print into: no line of their JSON is wrapped. */
export const LIST_COLS = 4000

/**
 * Claude Code's project folder: every character that is not a letter or digit
 * becomes `-`. Past 200 characters it shortens the name with a hash this does
 * not reproduce, so a long path answers "unknown" rather than "missing".
 */
function claudeTranscript(home: string, cwd: string, id: string): string | undefined {
  const folder = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  if (folder.length > 200) return undefined
  return joinHome(home, ".claude", "projects", folder, `${id}.jsonl`)
}

/*
 * Read off `--help` of each installed CLI, not remembered:
 *
 *   claude    --session-id <uuid>   start under a given id
 *             -r, --resume <id>     reopen it
 *   pi        --session-id <id>     "use exact project session ID, creating
 *                                   it if missing" — the same trick
 *             --session <path|id>   reopen it
 *   codex     resume <SESSION_ID>   subcommand, not a flag; --last for the
 *                                   most recent
 *   hermes    -r, --resume <id>     / -c, --continue
 *   kimi      -S, --session <id>    / -c, --continue
 *   agy       --conversation <id>   / -c, --continue
 *   prime     -r, --resume <id>     / -c, --continue
 *   nikcli    -s, --session <id>    / -c, --continue, the whole project's
 *             latest: `api session.list` with a directory instead
 *   opencode  -s, --session <id>    / -c, --continue
 *   grok      -s, --session-id <uuid>   start under a given id
 *             -r, --resume <id>     reopen it / -c, --continue
 *   gemini    -r, --resume <value>  takes "latest" or an index, never a uuid
 *
 * Three of them let ADE choose the id, and only those can promise the exact
 * conversation back. The rest can be resumed by an id ADE has no way to learn
 * — herdr solves that by installing a hook into each CLI's own config so the
 * CLI reports its id back, which is more capable and edits files ADE does not
 * own. Until that is a decision someone makes on purpose, those agents get
 * "the most recent one in this directory".
 *
 * gemini is the one that cannot be pinned at all: it will start under an id
 * and then refuse to take it back, so writing the id down would suggest a
 * precision ADE does not have.
 */
export const RESUME: Record<string, ResumeRecipe> = {
  "claude-code": {
    start: (id) => ["--session-id", id],
    byId: (id) => ["--resume", id],
    last: () => ["--continue"],
    fork: (parent, child) => ["--resume", parent, "--fork-session", "--session-id", child],
    transcript: claudeTranscript,
  },
  pi: {
    start: (id) => ["--session-id", id],
    byId: (id) => ["--session", id],
    last: () => ["--continue"],
  },
  codex: {
    byId: (id) => ["resume", id],
    last: () => ["resume", "--last"],
    fork: (parent) => ["fork", parent],
  },
  opencode: {
    byId: (id) => ["--session", id],
    last: () => ["--continue"],
  },
  nikcli: {
    byId: (id) => ["--session", id],
    lastHere: {
      /*
       * A GET's parameters go in the query: `nikcli api` puts `-d` in the
       * request's body and only `--param` in its URL, and `session.list`
       * reads the query. Sent as `-d`, `roots` and `limit` never arrived and
       * every restore read the folder's whole list (lettura di Mimo, F2;
       * measured, 781 conversations for `limit: 1`). The folder is the
       * process's own directory, which the command sends by itself.
       */
      args: () => ["api", "session.list", "--log-level", "warn", "--param", "roots=true", "--param", `limit=${LAST_HERE_LIMIT}`],
      read: lastNikcliHere,
    },
    mint: {
      args: (title) => ["api", "session.create", "--log-level", "warn", "-d", JSON.stringify({ title })],
      read: mintedNikcliId,
    },
    exists: {
      args: (id) => ["api", "session.get", "--log-level", "warn", "--param", `sessionID=${id}`],
      read: nikcliConversationThere,
    },
  },
  grok: {
    start: (id) => ["--session-id", id],
    byId: (id) => ["--resume", id],
    last: () => ["--continue"],
  },
  hermes: {
    byId: (id) => ["--resume", id],
    last: () => ["--continue"],
  },
  kimi: {
    byId: (id) => ["--session", id],
    last: () => ["--continue"],
  },
  agy: {
    byId: (id) => ["--conversation", id],
    last: () => ["--continue"],
    transcript: (home, _cwd, id) => joinHome(home, ".gemini", "antigravity-cli", "conversations", `${id}.db`),
    latest: {
      path: (home) => joinHome(home, ".gemini", "antigravity-cli", "cache", "last_conversations.json"),
      read: agyLatest,
    },
  },
  prime: {
    byId: (id) => ["--resume", id],
    last: () => ["--continue"],
  },
}

/**
 * How to ask this agent's CLI for its most recent conversation in `cwd`, for
 * a `here` plan. Pure: the caller runs the command and hands the output back.
 */
export function planLastHere(
  agentId: string,
  cwd: string,
  taken: ReadonlySet<string>,
  marks: readonly string[] = [],
): { args: string[]; read: (output: string) => string | null | undefined } | undefined {
  const lastHere = RESUME[agentId]?.lastHere
  return lastHere ? { args: lastHere.args(cwd), read: (output) => lastHere.read(output, cwd, taken, marks) } : undefined
}

/**
 * How to ask this agent's CLI for a conversation id, when that is the way.
 *
 * Pure, like the rest of this module: the caller runs the command and hands
 * the output back to `read`.
 */
export function planMint(
  agentId: string,
  title: string,
): { args: string[]; read: (output: string) => string | undefined } | undefined {
  const mint = RESUME[agentId]?.mint
  return mint ? { args: mint.args(title), read: mint.read } : undefined
}

/**
 * What ADE can promise about bringing this session back, for the pane to say.
 *
 * `exact` — its own conversation, by id.
 * `last`  — whatever turns out to be the most recent one in that directory;
 *           true enough with one session there, a coin toss with two.
 * `none`  — nothing: the agent starts again and the task is typed in.
 *
 * `sameDirectory` is how many other sessions of the same agent share the
 * directory, which is what turns `last` from a promise into a guess.
 */
export function resumePromise(input: {
  agentId: string
  resumeId?: string
  sharedDirectory?: boolean
}): "exact" | "last" | "none" {
  const recipe = RESUME[input.agentId]
  if (!recipe) return "none"
  if (input.resumeId && recipe.byId) return "exact"
  if ((recipe.last || recipe.lastHere) && !input.sharedDirectory) return "last"
  return "none"
}

/**
 * Whether ADE has to tell the user that a conversation of this agent is gone.
 *
 * Only an agent that keeps conversations can have lost one. A plain terminal is
 * in the table with no recipe, so `resumePromise` answers `none` for one
 * because there was never a conversation to reopen — and the strip announcing a
 * lost one says the opposite of the truth. It showed on every Terminal pane.
 */
export function lostConversation(
  agentId: string,
  promise: "exact" | "last" | "none",
  resumed: boolean,
): boolean {
  return !resumed && promise === "none" && RESUME[agentId] !== undefined
}

/**
 * A conversation id, in the form every one of these CLIs asks for.
 *
 * `crypto.randomUUID` and not a counter: the id is handed to a program that
 * validates it as a UUID, and it has to stay unique across launches, which a
 * counter reset by a restart does not.
 */
export function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  // A host without `crypto` is a test harness; the shape is what matters.
  const hex = (length: number) =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("")
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`
}

export interface StartPlan {
  /** Arguments to add to the bare command. */
  readonly args: string[]
  /**
   * The id to write down on the pane, when there is one worth writing down.
   *
   * Absent means this agent cannot be asked for a specific conversation, so
   * a restore will fall back to "the most recent one here" or to starting
   * fresh — and the pane should not claim otherwise.
   */
  readonly resumeId?: string
}

/** How to start a brand-new session for this agent. */
export function planStart(agentId: string, id = newSessionId()): StartPlan {
  const recipe = RESUME[agentId]
  if (!recipe?.start) return { args: [] }
  return { args: recipe.start(id), resumeId: id }
}

/**
 * How to start a session as a fork of `parentId`, or why it cannot be one.
 *
 * `resumeId` is the child's own id when the CLI takes one (Claude); otherwise
 * the child's id arrives later from the CLI's hook, like any other session.
 */
export function planFork(
  agentId: string,
  parentId: string | undefined,
  childId = newSessionId(),
): { args: string[]; resumeId?: string } | { error: string } {
  const recipe = RESUME[agentId]
  if (!recipe?.fork) return { error: `${agentId} non sa biforcare una conversazione: avvia senza --fork` }
  if (!parentId) return { error: "questa sessione non ha ancora una conversazione salvata da cui partire" }
  return { args: recipe.fork(parentId, childId), ...(recipe.start ? { resumeId: childId } : {}) }
}

export interface ResumeRequest {
  readonly agentId: string
  /** The id recorded when the session started, if the agent supported one. */
  readonly resumeId?: string
  /**
   * Whether another pane being restored into the same directory has already
   * claimed "the most recent conversation here".
   *
   * The whole reason this argument exists: with two sessions restored into
   * one project, `--continue` on both reopens the same conversation twice,
   * and the two panes then race each other inside it.
   */
  readonly lastTaken?: boolean
  /**
   * The CLI never wrote the conversation `resumeId` names — see
   * `ResumeRecipe.transcript`. There is nothing to reopen, and falling back
   * to "the most recent one here" would hand the pane somebody else's thread.
   */
  readonly missing?: boolean
}

export type ResumePlan =
  /**
   * Reopen a conversation. `args` go after the bare command.
   *
   * `via` says which of the two promises was kept — the exact conversation,
   * or merely the most recent one in this directory — because they are not
   * equally true and the caller has to be able to tell the user which it got.
   */
  | { readonly kind: "resume"; readonly via: "id" | "last"; readonly args: string[] }
  /**
   * Ask the CLI for this directory's most recent conversation, then reopen
   * it by id; a new one when there is none. See `ResumeRecipe.lastHere`.
   */
  | { readonly kind: "here" }
  /**
   * Nothing to reopen: start fresh and type the task, as ADE always did.
   *
   * `resumeId` is the id to start under again when the recorded one was never
   * used, so the pane keeps the id it already carries.
   */
  | { readonly kind: "fresh"; readonly resumeId?: string; readonly gone?: true }

/** What to do with one session that was live when the app went away. */
export function planResume(request: ResumeRequest): ResumePlan {
  const recipe = RESUME[request.agentId]
  if (!recipe) return { kind: "fresh" }

  if (request.resumeId && request.missing) {
    // `gone`: the id the pane carries is not to be reopened, nor kept (`startProcess`).
    return recipe.start ? { kind: "fresh", resumeId: request.resumeId } : { kind: "fresh", gone: true }
  }
  if (request.resumeId && recipe.byId) {
    return { kind: "resume", via: "id", args: recipe.byId(request.resumeId) }
  }
  if (recipe.lastHere && !request.lastTaken) return { kind: "here" }
  if (recipe.last && !request.lastTaken) {
    return { kind: "resume", via: "last", args: recipe.last() }
  }
  return { kind: "fresh" }
}

/**
 * Whether "the most recent conversation here" is already spoken for when
 * `pane` is reopened on its own (not in a whole restore, see `planRestore`).
 *
 * Per folder, as in `planRestore`: a pane of the same agent in another folder
 * has a different "most recent", and counting it made every pane without an
 * id start a new conversation as soon as any other pane of that agent was open
 * (prove dal vivo 2, difetto B).
 *
 * For an agent that asks for the most recent conversation here and then
 * reopens it by id (`lastHere`), the panes holding an id are left out of the
 * answer already, so only another pane without one can take the same
 * conversation, and of two such panes the earlier one has it. For an agent
 * that can only say "the most recent one" (`last`), any other pane of the
 * folder may be in it.
 */
export function lastTakenFor<P extends { id: string; agent?: string; model?: string; cwd?: string; resumeId?: string }>(
  pane: P,
  panes: readonly P[],
): boolean {
  const agentId = pane.agent ?? pane.model ?? ""
  const folder = folderKey(pane.cwd)
  const excludesHeld = Boolean(RESUME[agentId]?.lastHere)
  const at = panes.findIndex((other) => other.id === pane.id)
  return panes.some(
    (other, index) =>
      other.id !== pane.id &&
      (other.agent ?? other.model) === agentId &&
      folderKey(other.cwd) === folder &&
      (!excludesHeld || (!other.resumeId && at >= 0 && index < at)),
  )
}

/**
 * The conversation a start opens: the one it minted or found, or the one it
 * reopens by the id the pane saved.
 *
 * Reopening by id carries no id of its own in the arguments (`byId` builds
 * them), so a check on the minted id alone never matched the case it was
 * written for: the note that the conversation belongs to another folder was
 * never said at a restart, and the folder was forgotten at every one
 * (lettura di Mimo, F4).
 */
/**
 * Whether a start types its task, and what the pane says it is doing then.
 *
 * A resumed conversation is not handed its task again (the agent already has
 * the thread) unless the user has just written it. The pane's status followed
 * the task alone: a resumed pane with a task was "working" with nothing
 * typed, and once its terminal went quiet the quiet check turned it into
 * "Disponibile", losing «Sessione ripresa» (prova dal vivo 7, 1b rifatta).
 */
export function startingState(input: { task: string; resumed: boolean; typeIntoResumed: boolean }): {
  typesTask: boolean
  status: "working" | "idle"
  activity: "resumed" | "running" | "ready"
} {
  const typesTask = Boolean(input.task.trim()) && (!input.resumed || input.typeIntoResumed)
  return {
    typesTask,
    status: typesTask ? "working" : "idle",
    activity: input.resumed ? "resumed" : typesTask ? "running" : "ready",
  }
}

export function openedConversation(plan: ResumePlan | undefined, minted: string | undefined, saved: string | undefined): string | undefined {
  if (minted) return minted
  return plan?.kind === "resume" && plan.via === "id" ? saved : undefined
}

/** The key of "the most recent conversation" of an agent in a folder. */
function claimKey(agentId: string, cwd: string | undefined): string {
  return `${agentId}\u0000${folderKey(cwd)}`
}

/**
 * The conversations ADE asked a CLI to open in this run (`mint`), finished
 * and under way.
 *
 * A pane that mints is not holding the id yet while the CLI answers, and a
 * pane looking for "the most recent conversation here" in the same folder
 * got it from `session.list` as the newest: two panes on one conversation
 * (prova dal vivo 7, 1b). A minted conversation is its pane's, never
 * another's "here" while that pane is open. Closed, the conversation is free
 * again, and a later "here" of the same run can reopen it (review of
 * ripristino-quater, BASSO 1): each id is kept with the pane that asked.
 */
export class MintLedger {
  /** Each minted conversation, with the pane that asked for it. */
  readonly minted = new Map<string, string>()
  private readonly pending = new Set<Promise<void>>()

  /** Follows one mint: its id joins `minted` before the mint counts as settled. */
  track<T extends string | undefined>(mint: Promise<T>, owner: string): Promise<T> {
    const recorded: Promise<void> = mint.then(
      (id) => {
        if (id) this.minted.set(id, owner)
      },
      () => undefined,
    )
    this.pending.add(recorded)
    void recorded.then(() => this.pending.delete(recorded))
    return mint
  }

  /** The mints under way now, to be waited for. */
  underWay(): readonly Promise<void>[] {
    return [...this.pending]
  }
}

/**
 * "The most recent conversation here", leaving out the ones other panes hold
 * (`taken`) and the ones ADE minted for a pane still open (`open`, which the
 * pane asking answers false for itself).
 *
 * A mint under way when the list answers can be in the list, the newest,
 * before its id reaches ADE: those are waited for, and the same list is read
 * again without them. One that starts after the list answered cannot be in
 * it, and is not waited for.
 *
 * For `patience` at most (the list's own time): a mint may take 30 s, and a
 * "here" waiting on it said nothing for 45 (review of ripristino-sexies,
 * nota 1). Past it the list is read as it is: a conversation minted for an
 * open pane carries that pane's mark in its title (`mintMark`), which `read`
 * already leaves out.
 */
export async function lastHereBesideMints(
  ask: (read: (output: string) => string | null | undefined) => Promise<string | null | undefined>,
  read: (output: string, taken: ReadonlySet<string>) => string | null | undefined,
  taken: ReadonlySet<string>,
  mints: MintLedger,
  open: (owner: string) => boolean,
  patience: { ms: number; timers?: Timers } = { ms: LIST_MS },
): Promise<string | undefined> {
  const excluded = () => {
    const out = new Set(taken)
    for (const [id, owner] of mints.minted) if (open(owner)) out.add(id)
    return out
  }
  let answered = ""
  let underWay: readonly Promise<void>[] = []
  const found = await ask((output) => {
    const id = read(output, excluded())
    if (id !== undefined) {
      answered = output
      underWay = mints.underWay()
    }
    return id
  })
  if (!found) return undefined
  if (underWay.length > 0) {
    const timers = patience.timers ?? { set: (run, ms) => setTimeout(run, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
    let handle: unknown
    await Promise.race([
      Promise.all(underWay),
      new Promise<void>((resolve) => (handle = timers.set(resolve, patience.ms))),
    ])
    timers.clear(handle)
  }
  const now = excluded()
  if (!now.has(found)) return found
  return read(answered, now) ?? undefined
}

/**
 * The folders whose "most recent conversation" a restore has handed out, per
 * agent: the claims `planRestore` made.
 *
 * The panes it plans are not the only ones that start: the ones whose agent
 * had already exited are reopened in the same breath (`exitedToReopen`), and
 * `lastTakenFor` only sees the ids panes hold, not a claim made a moment ago
 * whose `session.list` has not answered yet. A reopened pane placed before
 * the planned one took `here` too, and the two could open one conversation
 * (lettura di Mimo, F3).
 */
export function restoreClaims(planned: readonly { session: { agentId: string; cwd: string }; plan: ResumePlan }[]): Set<string> {
  const claims = new Set<string>()
  for (const { session, plan } of planned) {
    if (plan.kind === "here" || (plan.kind === "resume" && plan.via === "last")) claims.add(claimKey(session.agentId, session.cwd))
  }
  return claims
}

/** Whether a restore already handed out this folder's "most recent conversation" (`restoreClaims`). */
export function claimedByRestore(claims: ReadonlySet<string> | undefined, agentId: string, cwd: string | undefined): boolean {
  return Boolean(claims?.has(claimKey(agentId, cwd)))
}

/**
 * Plans a whole restore, so the "most recent" claim is handed out once.
 *
 * Sessions are given in the order they were saved, and the first one in a
 * directory that needs "the most recent conversation" gets it. The rest of
 * that directory start fresh rather than all reopening the same one.
 *
 * The same goes for an exact id (ripristino review, point 1): nikcli's tabs
 * are one list for every TUI, so a pane that followed a tab can hold the
 * conversation another pane holds, and two `--session <id>` would write into
 * one conversation. The first pane keeps it; a later one gets `here` when
 * its directory's claim is still free (which leaves out the ids the other
 * panes hold), a new conversation otherwise, and `sharedWith` names the pane
 * that kept it, for the caller to say so.
 */
export function planRestore<T extends { agentId: string; cwd: string; resumeId?: string; missing?: boolean }>(
  sessions: readonly T[],
): { session: T; plan: ResumePlan; sharedWith?: T }[] {
  const claimed = new Set<string>()
  const holders = new Map<string, T>()
  return sessions.map((session) => {
    const key = claimKey(session.agentId, session.cwd)
    const held = session.resumeId !== undefined ? holders.get(`${session.agentId}\u0000${session.resumeId}`) : undefined
    if (held) {
      const plan: ResumePlan = RESUME[session.agentId]?.lastHere && !claimed.has(key) ? { kind: "here" } : { kind: "fresh" }
      if (plan.kind === "here") claimed.add(key)
      return { session, plan, sharedWith: held }
    }
    if (session.resumeId !== undefined) holders.set(`${session.agentId}\u0000${session.resumeId}`, session)
    const plan = planResume({
      agentId: session.agentId,
      ...(session.resumeId !== undefined ? { resumeId: session.resumeId } : {}),
      lastTaken: claimed.has(key),
      ...(session.missing ? { missing: true } : {}),
    })
    // Claimed only when it was actually used: a session resumed by its own id
    // leaves "the most recent one" free for the next pane.
    if ((plan.kind === "resume" && plan.via === "last") || plan.kind === "here") claimed.add(key)
    return { session, plan }
  })
}
