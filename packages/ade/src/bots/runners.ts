/**
 * Which program a bot's turns run on.
 *
 * A bot is a ragu agent file, and ragu is still the default: its turns run
 * on ADE's ragu server (B8d, `serve-turn.ts`), with the providers `ragu
 * auth` knows. But the user's
 * subscriptions are not all reachable from there. An Anthropic subscription is
 * only usable through Claude Code — the Agent SDK is Claude Code as a library,
 * and `claude -p --output-format stream-json` is the same loop from the
 * command line, signed in with the user's own account. A ChatGPT subscription
 * is Codex's. So a bot names its runner, and
 * each runner gets its turn from the CLI the user already signed in to.
 *
 * The runner is ADE's own frontmatter key (`runner:`), like `avatar:`: ragu
 * ignores keys it does not know, so the file still runs in ragu's TUI.
 *
 * Claude Code and Codex print one JSON object per line, so both adapters here
 * are the same shape: the arguments for one turn, and a fold from an event to
 * the thread. Pure, in a `.ts`, and tested against lines the real CLIs printed.
 */

import { t } from "../i18n"
import { formatUsd } from "./format"
import { stripAnsi } from "../session/stream"
import type { BotAccount } from "./account"
import type { AgentFile } from "./ragu"
import { RAGU_COMMAND } from "./ragu"
import { PLAN_RUNNERS } from "./terms"
import { claudeRefusals, classifyCommand } from "./approval"
import {
  appendMessage,
  applyJsonLine,
  attachOutput,
  errorText,
  noteTurnUsage,
  noteReportedModel,
  sealTurn,
  type Talk,
} from "./talk"
import { EXECUTES_LATER } from "./app-folder"

export type RunnerId = "ragu" | "claude" | "codex"

export interface Runner {
  readonly id: RunnerId
  readonly label: string
  /** The executable, as the pty allowlist names it. */
  readonly command: string
  /**
   * Models to offer. Empty for ragu, whose list is asked of ragu itself.
   * The field stays free text for the others: these CLIs accept aliases and
   * new names long before a list here learns them.
   */
  readonly models: readonly string[]
  /** The effort flag's values. Empty for ragu, whose efforts depend on the model. */
  readonly efforts: readonly string[]
  /** How to sign in, run in a terminal pane. */
  readonly login: readonly string[]
  /** How to ask whether it is signed in, when the CLI can say. */
  readonly status?: readonly string[]
}

export const RUNNERS: readonly Runner[] = [
  {
    id: "ragu",
    label: "Ragu Code",
    command: RAGU_COMMAND,
    models: [],
    // A ragu model's efforts are its own variants, read from ragu (`effort.ts`), not a list here.
    efforts: [],
    login: ["auth", "login"],
    status: ["auth", "list"],
  },
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    models: [
      "fable",
      "opus",
      "sonnet",
      "haiku",
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    login: ["auth", "login"],
    status: ["auth", "status"],
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    models: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    login: ["login"],
    status: ["login", "status"],
  },
]

/**
 * How a turn is paid for.
 *
 * `plan` is Claude Code or Codex: the CLI may print a dollar figure, and it
 * is not a charge on a card. `free` is a model whose id ends in `:free`.
 * `api` is a named ragu model. No model at all is `metered`: the default
 * can be paid, and calling it an API key would be a guess.
 */
export type SpendKind = "plan" | "api" | "free" | "metered"

export function isFreeModel(model?: string | undefined): boolean {
  return typeof model === "string" && /:free$/i.test(model.trim())
}

export function spendKind(
  runnerId?: string | undefined,
  model?: string | undefined,
  account?: BotAccount | undefined,
): SpendKind {
  if (typeof runnerId === "string" && PLAN_RUNNERS.includes(runnerId)) return account?.mode === "key" ? "api" : "plan"
  if (isFreeModel(model)) return "free"
  if (!model?.trim()) return "metered"
  return "api"
}

export interface SpendLine {
  readonly kind: SpendKind
  readonly model: string
  readonly tokens: number
  /** Set only for a real charge. A plan and a free model never have one. */
  readonly usd?: string
  /** Codex with a key reports tokens and no dollar amount. */
  readonly unreported?: true
}

export { formatUsd }

/** What a turn shows for its model and its cost. The dollar amount is omitted when it is not money spent. */
export function spendLine(input: {
  readonly runnerId?: string | undefined
  readonly model?: string | undefined
  readonly account?: BotAccount | undefined
  /** The mode of a turn already finished. It wins over the bot's account now. */
  readonly kind?: SpendKind | undefined
  readonly tokens: number
  readonly costUsd: number
}): SpendLine {
  const kind = input.kind ?? spendKind(input.runnerId, input.model, input.account)
  const model = input.model?.trim() ?? ""
  const unreported = kind === "api" && input.runnerId === "codex"
  return {
    kind,
    model,
    tokens: input.tokens,
    ...(!unreported && (kind === "api" || kind === "metered") && input.costUsd > 0
      ? { usd: formatUsd(input.costUsd) }
      : {}),
    ...(unreported ? { unreported: true as const } : {}),
  }
}

/**
 * What «Genera con ragu» spends.
 *
 * The model named in the form is the one `agent create --model` writes the
 * file with. With none named, ragu's own default writes it, and a default
 * is not free.
 */
export function generationSpend(model?: string | undefined): { readonly model: string; readonly paid: boolean } {
  const named = model?.trim() ?? ""
  if (!named) return { model: "", paid: true }
  return { model: named, paid: !isFreeModel(named) }
}

export function runnerAccount(id: RunnerId | string): string {
  switch (id) {
    case "claude":
      return t("bots.runner.account.claude")
    case "codex":
      return t("bots.runner.account.codex")
    default:
      return t("bots.runner.account.ragu")
  }
}

export function runnerById(id: string | undefined): Runner {
  return RUNNERS.find((runner) => runner.id === id) ?? RUNNERS[0]!
}

export function isRunnerId(value: string | undefined): value is RunnerId {
  return RUNNERS.some((runner) => runner.id === value)
}

/* ── one turn ───────────────────────────────────────────────────────────── */

export interface TurnSpec {
  readonly bot: AgentFile
  readonly message: string
  readonly sessionId?: string
  /**
   * Claude Code without the user's MCP servers and settings files: a turn
   * measured at 9.3 s drops to 3.4 s, and the answer loses the connector
   * noise. The account still works, since the login is not a setting. Without
   * user settings `ade-msg` is no longer allowed, so it is allowed here by
   * pattern. Codex gains nothing measurable from the same, so it ignores it.
   *
   * Auto-memory is off too: a bot asked to remember a number wrote it into the
   * user's own Claude memory, where every other session then reads it.
   */
  readonly lean?: boolean
  /**
   * No tool at all: Claude Code gets `--tools ""`, not even `ade-msg`, and ragu's session denies every
   * tool (`planner` in `serve-rules.ts`). For a turn that only answers from what it is given, such as the
   * voice's planner, whose input carries text others can write (pane titles). Codex has no such flag and
   * ignores it.
   */
  readonly noTools?: boolean
  /**
   * The folder `ade-msg` drops its messages in (`<mailbox>/outbox`), for a
   * turn that may not write but must still talk to ADE. Codex's read-only
   * sandbox refuses that write too, so such a turn runs in `workspace-write`
   * with this folder as its workspace instead of the project: `ade-msg` works
   * and the project stays out of reach.
   */
  readonly outbox?: string
  /** Claude Code sends the answer as it is written (`stream_event`), not only when each message is complete. */
  readonly partial?: boolean
  /**
   * Claude Code reads its messages from stdin, one JSON line each, and stays
   * up between them (`warm.ts`). `message` is then not passed.
   */
  readonly stdin?: boolean
  /**
   * A turn from a chat, through a bot's gateway (G5): nobody is at the
   * computer to see what it does. See `remoteTools`.
   */
  readonly remote?: RemoteTools
  /**
   * Claude Code and Codex only. Absent is a subscription: the spawn strips
   * inherited API keys. A key is the name in ADE's index, never the value.
   */
  readonly account?: BotAccount
  /**
   * The caller answers questions (B8c, the Bots panel's `controller.ts`).
   * Claude Code, which cannot ask mid-turn, is then refused only what the
   * bot's «Sempre» does not cover. ragu's turns run on ADE's server (B8d),
   * with the rules of `serve-rules.ts`.
   */
  readonly approvals?: boolean
  /** The bot's «Sempre» (`approval.ts`), with `approvals`: what Claude Code is not refused. */
  readonly always?: readonly string[]
  /**
   * A turn nobody watches (B11, a routine): no shell at all, not even
   * `ade-msg`, which can open a session with a shell of its own. ragu gets
   * the `read-only` rules on ADE's server (B8d), Claude Code and Codex run
   * read-only too (B11 review:
   * Claude Code is refused Bash, Edit and Write, and edits are not accepted).
   * Claude Code is also lean and refused the web, as from a chat (choice 7).
   */
  readonly unattended?: boolean
  /** Claude Code only: the dollars the turn may spend (`--max-budget-usd`, B11). */
  readonly maxBudgetUsd?: number
  /**
   * Codex only, from a chat and in a routine: the MCP servers of the user's config.toml (`codexMcpNames`), each
   * switched off by name. Absent, or with a name that is not a plain one: the whole file is left out.
   */
  readonly codexMcpServers?: readonly string[]
}

/** An MCP server's name as it may go on Codex's command line: through npm's `.cmd` shim, nothing cmd.exe reads. */
const SAFE_MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** One part of a TOML dotted key: bare, "basic" or 'literal'. */
const TOML_KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`
const TOML_KEY = new RegExp(String.raw`^(${TOML_KEY_PART}(?:\s*\.\s*${TOML_KEY_PART})*)\s*=(.*)$`)
const TOML_HEADER = /^\[\[?\s*(.*?)\s*\]\]?\s*(?:#.*)?$/

/** A TOML dotted key's parts, unquoted; undefined when it is not one. */
function tomlKey(text: string): string[] | undefined {
  const part = new RegExp(String.raw`\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(\.|$)`, "y")
  const parts: string[] = []
  let at = 0
  while (at < text.length) {
    part.lastIndex = at
    const found = part.exec(text)
    if (!found) return undefined
    try {
      parts.push(found[1] ?? found[3] ?? (JSON.parse(`"${found[2] ?? ""}"`) as string))
    } catch {
      return undefined
    }
    at = part.lastIndex
    if (found[4] === "") break
  }
  return parts.length > 0 && at >= text.length ? parts : undefined
}

/**
 * The MCP servers named in Codex's config.toml, read without a TOML library: tables (`[mcp_servers.docs]` and the
 * ones under it), dotted keys and inline tables under `[mcp_servers]`. Undefined when the file says something this
 * reading cannot be sure of — an inline `mcp_servers = { … }`, a header it cannot read, a name that is not a plain
 * one: the turn then leaves the whole file out rather than miss a server.
 */
export function codexMcpNames(toml: string): readonly string[] | undefined {
  const names = new Set<string>()
  let table: string[] = []
  let open: string | undefined
  for (const raw of toml.split(/\r?\n/)) {
    if (open) {
      if (raw.includes(open)) open = undefined
      continue
    }
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("[")) {
      const header = TOML_HEADER.exec(line)
      const path = header ? tomlKey(header[1] ?? "") : undefined
      if (!path) {
        // A continuation of an array (`[`, `["a",`) cannot name a table: only a broken header that might is a doubt.
        if (/mcp_servers/.test(line)) return undefined
        continue
      }
      table = path
      if (path[0] === "mcp_servers" && path[1] !== undefined) names.add(path[1])
      continue
    }
    const assignment = TOML_KEY.exec(line)
    if (!assignment) continue
    const key = [...table, ...(tomlKey(assignment[1] ?? "") ?? [])]
    if (key[0] === "mcp_servers") {
      if (key[1] === undefined) return undefined
      names.add(key[1])
    }
    // A string over several lines opens here when its quotes are odd in number: its lines are not keys.
    for (const quotes of ['"""', "'''"]) {
      if (((assignment[2] ?? "").split(quotes).length - 1) % 2 === 1) {
        open = quotes
        break
      }
    }
  }
  const all = [...names]
  return all.every((name) => SAFE_MCP_NAME.test(name)) ? all : undefined
}

/**
 * Whether Codex, from a chat or in a routine, refused the options that switch its MCP servers and the web off: an
 * older version that does not know them, or a config.toml other than the one ADE read (`CODEX_HOME`), where a server
 * switched off by name is not there (`invalid transport`).
 */
export function codexOptionsRefused(said: string | undefined): boolean {
  return /unexpected argument|error loading config\.toml|unknown field|unknown variant|invalid transport/i.test(
    said ?? "",
  )
}

/*
 * From a chat and in a routine Codex reads the project only (bot-lettura-2, the Master's choice): its `read-only`
 * sandbox reads the whole disk, ~/.ssh included. A permissions profile of ADE's own reads the project and the paths
 * common tools need (`:minimal`), and `prefer_mxc` runs it in Windows' MXC isolation where the device has it, with no
 * administrator setup. `sandbox_mode` stays beside it, for a Codex that does not know profiles. No spaces: these go
 * through npm's `.cmd` shim. Checked on codex-cli 0.162.1 with a fake provider: inside read, outside «not found».
 */
const CODEX_PROJECT_ONLY = [
  "-c",
  'permissions.ade_project.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
  "-c",
  'default_permissions="ade_project"',
  "-c",
  "features.prefer_mxc=true",
]

/**
 * Whether Codex would not start with that profile: Windows' `unelevated` sandbox cannot keep reads in the project, and
 * Codex says so before any model call. The turn fails closed, never tried again with a wider sandbox.
 */
export function codexSandboxCannotRead(said: string | undefined): boolean {
  return /cannot enforce split filesystem read restrictions|requires the elevated Windows sandbox backend/i.test(
    said ?? "",
  )
}

/**
 * What a turn from a chat may run (G5, D93). With `commands` off, the
 * default, no shell at all. With it on (the bot's «Comandi da remoto», the
 * owner's choice in ADE), ragu asks about every command, and the question
 * goes to the phone. Only ragu: Claude Code and Codex cannot ask mid-turn,
 * so every command would be approved in advance, not one by one as D93
 * wants; from a chat they never have a shell (G5 review, M1).
 * Writes stay in the project, never where a file becomes a command run later
 * (`EXECUTES_LATER`). The approval is a heuristic, not a boundary: the
 * boundary is the tools a turn is given.
 */
export interface RemoteTools {
  readonly commands: boolean
}

/**
 * Whether the runner itself refuses what `disabledTools` turns off, rather
 * than only being asked to. ragu takes its tools from the agent file, and a
 * turn has no way to hand it others without an environment the pty does not
 * pass, so a tool refused here would still run there.
 */
export function enforcesDisabledTools(id: RunnerId): boolean {
  return id !== "ragu"
}

/**
 * ragu's tool names, as Claude Code spells them. A bot with a tool turned
 * off in ragu has it refused in Claude Code too.
 *
 * In Claude Code 2.1.301 the subagent is `Agent`, and `Task` still its alias, kept for an older version. The todo list
 * is `TaskCreate`, `TaskGet`, `TaskList` and `TaskUpdate`; `TodoWrite` comes back only with CLAUDE_CODE_ENABLE_TASKS=0
 * (bot-lettura-2, checked with a fake provider). An unknown name is ignored.
 */
const CLAUDE_TOOLS: Record<string, readonly string[]> = {
  bash: ["Bash", "PowerShell"],
  edit: ["Edit", "NotebookEdit"],
  write: ["Write"],
  read: ["Read"],
  grep: ["Grep"],
  glob: ["Glob"],
  webfetch: ["WebFetch"],
  websearch: ["WebSearch"],
  task: ["Agent", "Task"],
  todowrite: ["TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"],
}

/** What a routine's Claude Code turn is refused besides the shell: it reads, it does not write. */
const READ_ONLY_REFUSED: readonly string[] = ["edit", "write"]

/**
 * What a turn from a chat and a routine are refused besides the shell: the web, as ragu's turns there
 * (`READ_TOOLS` in `serve-rules.ts`, the user's choice 7). MCP servers are left out by `lean`, which both are.
 */
const UNWATCHED_REFUSED: readonly string[] = ["webfetch", "websearch"]

/*
 * What a turn is pre-approved in place of a tool's bare name (review-anteprima-pagina §3). A rule with no path matches
 * every file on the disk: `Edit` and `Write` with `acceptEdits` wrote anywhere, ~/.claude/settings.json's hooks
 * included. `acceptEdits` alone writes in the working folder and asks outside it, which `-p` refuses: so on every
 * turn, the panel's too (bot-lettura-2, the Master's choice), writing is pre-approved by the mode only.
 */
const WATCHED_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  edit: [],
  write: [],
}

/*
 * From a chat and in a routine reading too: `Read`, `Grep` and `Glob` read ~/.ssh or another project's .env with no
 * question. `Read(./**)` is the project, and Read rules cover Grep and Glob; inside the working folder they need no
 * approval anyway. The setting below refuses all three outside it in every mode, Claude Code 2.1.257 and later. In the
 * panel reading stays free: the user is watching.
 * Checked on 2.1.301 with a fake provider: an absolute path, `..` and a junction out of the project refused.
 */
const UNWATCHED_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  ...WATCHED_ALLOWED,
  read: ["Read(./**)"],
  grep: [],
  glob: [],
}
const UNWATCHED_SETTINGS = '{"autoMemoryEnabled":false,"permissions":{"blockReadsOutsideWorkingDirectories":true}}'

/*
 * Claude Code's messages to the other Claude sessions on the machine: `ListAgents` and `SendMessage` run in `-p` with
 * no question (2.1.301, the same fake provider), so a turn could ask another session, one in `bypassPermissions` say,
 * to do what it may not. Refused on every turn: a bot talks to the sessions with `ade-msg`, through ADE. They have no
 * ragu name.
 */
const SESSION_MESSAGES: readonly string[] = ["ListAgents", "SendMessage"]

/*
 * A bot from the open project's `.nikcli/agent/` (B3, audit A4): its persona
 * and settings were written by whoever wrote the repository. It runs only
 * once the user trusted that file (`trust.ts`), and even then with nothing
 * pre-approved that runs commands:
 *
 * - Claude Code: no shell or `ade-msg`, none of the project's local settings
 *   (which may hold hooks), and no writes where a file becomes code that runs
 *   later — `EXECUTES_LATER`. Writing elsewhere stays: the user was told so.
 * - Codex: read-only, always. `codex exec` forces `approval_policy` to never
 *   whatever `-c` says (review B3, A1), so the sandbox is the only limit, and
 *   `workspace-write` would let it run anything inside the project.
 * - ragu reads the file itself, so `trust.ts` refuses one that grants
 *   itself permissions.
 */
function fromRepository(bot: AgentFile): boolean {
  return bot.scope === "project"
}

// `EXECUTES_LATER` (app-folder.ts): the folders where a write turns into a command run later.
const EXECUTES_LATER_RULES = EXECUTES_LATER.flatMap((path) =>
  ["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(./${path}/**)`),
)

export function canWrite(bot: AgentFile): boolean {
  return !bot.disabledTools.includes("edit") && !bot.disabledTools.includes("write")
}

/** The bot's persona put before the first message, for a runner with no system prompt flag. */
export function withInstructions(bot: AgentFile, message: string): string {
  if (!bot.prompt.trim()) return message
  return `Istruzioni del bot "${bot.identifier}":\n${bot.prompt.trim()}\n\n---\n\n${message}`
}

/*
 * What a bot file may put into Codex's options (B1, audit A1). `variant` goes
 * inside a TOML string in `-c`, and `model` after `-m`: a quote or a line
 * break there wrote a second setting (`sandbox_mode=…`), and on a `.cmd`
 * shim an `&` ran a command. A value outside these shapes is left out, and
 * the turn runs with Codex's own default.
 */
export const SAFE_EFFORT = /^[a-z]{1,16}$/
export const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/

/*
 * For `codex exec` and `exec resume` a PROMPT of `-` means «read it from
 * stdin», and the turn hung until stopped (B1 review, BASSO 1). A message
 * that is only a dash goes with a space before it: the same text, not that
 * argument.
 */
const notStdin = (prompt: string) => (prompt.trim() === "-" ? " -" : prompt)

/**
 * The account flag for Claude Code or Codex.
 *
 * A missing account is a subscription. Key mode never falls back to that:
 * no name still asks for `account-key`, and Rust refuses the spawn.
 */
function accountLaunch(account: BotAccount | undefined): {
  readonly flags: readonly string[]
  readonly secrets?: readonly string[]
} {
  if (account?.mode === "key") {
    return account.key ? { flags: ["account-key"], secrets: [account.key] } : { flags: ["account-key"] }
  }
  return { flags: ["account-plan"] }
}

export function turnCommand(
  runner: Runner,
  spec: TurnSpec,
): {
  readonly command: string
  readonly args: string[]
  readonly cwd?: string
  readonly flags?: readonly string[]
  readonly secrets?: readonly string[]
} {
  const { bot, message, sessionId } = spec
  switch (runner.id) {
    case "ragu":
      // A bot's ragu turn runs on ADE's server with its session's rules (B8d, `serve-turn.ts`): no process.
      throw new Error(t("bots.turn.raguOnServer"))
    case "claude": {
      /*
       * `-p` cannot ask for permission, so what the bot may do is decided up
       * front: its allowed tools pre-approved, edits accepted when it may
       * write, and anything else refused and reported in the result.
       */
      const args = ["-p", "--output-format", "stream-json", "--verbose"]
      if (spec.stdin) args.push("--input-format", "stream-json")
      if (spec.partial) args.push("--include-partial-messages")
      if (bot.model) args.push("--model", bot.model)
      if (bot.effort) args.push("--effort", bot.effort)
      if (bot.prompt.trim()) args.push("--append-system-prompt", bot.prompt.trim())
      if (sessionId) args.push("--resume", sessionId)
      /*
       * A lean turn without a shell keeps one: `ade-msg`, allowed by pattern.
       * Refusing Bash outright would refuse that too, since a refusal beats
       * any allow; left out of the allowed list instead, every other command
       * is one `-p` cannot ask about, so it is refused. For that to hold, no
       * settings file may pre-approve a command, the project's local one
       * included.
       */
      const repository = fromRepository(bot)
      const remote = spec.remote
      const unattended = spec.unattended === true
      // From a chat and in a routine: lean always (no MCP server), no `ade-msg`, and never a shell, remote commands or not.
      const lean = spec.lean === true || remote !== undefined || unattended
      const unwatched = remote !== undefined || unattended
      const adeMsgOnly = lean && bot.disabledTools.includes("bash") && !repository && !remote && !unattended
      if (lean) {
        /*
         * No settings file at all, the project's `.claude/settings.local.json`
         * included: it can hold hooks, which are commands (B3b review). What a
         * bot may do is said below, tool by tool.
         */
        args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "")
        args.push("--settings", unwatched ? UNWATCHED_SETTINGS : '{"autoMemoryEnabled":false}')
      }
      args.push("--permission-mode", canWrite(bot) && !unattended ? "acceptEdits" : "default")
      const allowed = Object.entries(CLAUDE_TOOLS)
        .filter(
          ([tool]) => !bot.disabledTools.includes(tool) && !((repository || remote || unattended) && tool === "bash"),
        )
        .filter(([tool]) => !(unattended && READ_ONLY_REFUSED.includes(tool)))
        .filter(([tool]) => !(unwatched && UNWATCHED_REFUSED.includes(tool)))
        .flatMap(([tool, names]) => (unwatched ? UNWATCHED_ALLOWED : WATCHED_ALLOWED)[tool] ?? names)
      if (lean && !repository && !remote && !unattended) allowed.push("Bash(ade-msg *)", "PowerShell(ade-msg *)")
      const disallowed = bot.disabledTools
        .filter((tool) => !(adeMsgOnly && tool === "bash"))
        .flatMap((tool) => CLAUDE_TOOLS[tool] ?? [])
      if ((remote || unattended) && !disallowed.includes("Bash")) disallowed.push("Bash", "PowerShell")
      // A routine is read-only, like Codex's (B11 review, the Master's decision).
      if (unattended)
        for (const name of READ_ONLY_REFUSED.flatMap((tool) => CLAUDE_TOOLS[tool] ?? []))
          if (!disallowed.includes(name)) disallowed.push(name)
      if (unwatched)
        for (const name of UNWATCHED_REFUSED.flatMap((tool) => CLAUDE_TOOLS[tool] ?? []))
          if (!disallowed.includes(name)) disallowed.push(name)
      for (const name of SESSION_MESSAGES) if (!disallowed.includes(name)) disallowed.push(name)
      // A refusal beats an allow, `acceptEdits` included.
      if ((repository || remote) && canWrite(bot)) disallowed.push(...EXECUTES_LATER_RULES)
      /*
       * B8c: with a shell, the block list is refused on every turn and, for a
       * bot's turn in the panel, every danger its «Sempre» does not cover.
       * The thread reports the refusal (`permission_denials`).
       */
      if (allowed.includes("Bash")) disallowed.push(...claudeRefusals(spec.approvals ? (spec.always ?? []) : undefined))
      if (spec.noTools) {
        // Nothing to allow and nothing to refuse: with no tool there is no `ade-msg` to run either.
        args.push("--tools", "")
      } else {
        if (allowed.length > 0) args.push("--allowedTools", allowed.join(","))
        if (disallowed.length > 0) args.push("--disallowedTools", disallowed.join(","))
      }
      const budget = spec.maxBudgetUsd
      if (budget !== undefined && Number.isFinite(budget) && budget > 0) args.push("--max-budget-usd", String(budget))
      if (!spec.stdin) args.push("--", message)
      return { command: runner.command, args, ...accountLaunch(spec.account) }
    }
    case "codex": {
      /* `exec resume` has no `-s`; the sandbox goes through `-c`, which both take. */
      const repository = fromRepository(bot)
      const inOutbox = !repository && !canWrite(bot) && spec.outbox !== undefined
      // From a chat, read-only whatever the bot may do in ADE: `workspace-write` runs any command.
      const sandbox =
        !repository && !spec.remote && !spec.unattended && (canWrite(bot) || inOutbox) ? "workspace-write" : "read-only"
      // A project's bot says no approval policy: `codex exec` runs as `never`
      // whatever it is told (see `fromRepository`), and codex-cli 0.154 exits 1
      // on `untrusted` ("no longer supported; remove this setting", B7 live).
      // The read-only sandbox is its limit.
      const config = ["-c", `sandbox_mode="${sandbox}"`, ...(repository ? [] : ["-c", `approval_policy="never"`])]
      if (bot.effort && SAFE_EFFORT.test(bot.effort)) config.push("-c", `model_reasoning_effort="${bot.effort}"`)
      const model = bot.model && SAFE_MODEL.test(bot.model) ? ["-m", bot.model] : []
      const where = inOutbox ? { cwd: spec.outbox } : {}
      /*
       * From a chat and in a routine: no MCP server and no web, as ragu and Claude Code there (the user's choice 7).
       * `-c mcp_servers={}` does not do it: Codex merges it into the user's table, which stays whole (`codex mcp
       * list`). Each of the user's servers is switched off by name instead (`codexMcpServers`), so the rest of
       * config.toml — a provider of the user's own, the profiles — still holds. When the names could not be read,
       * `--ignore-user-config` leaves the whole file out, its servers with it; the login stays. The ChatGPT apps are
       * MCP servers of their own (`features.apps`), plugins can bring more, and the web search is on by default.
       * Checked on codex-cli 0.162.1 with no model turn, by the tools a turn offers the model, read from a fake
       * provider: 21 with the user's server, the apps and `web_search`; 8 with these, either way, none of those.
       * A feature goes through `-c`: `--disable` refuses a name an older Codex does not know.
       */
      const servers = spec.codexMcpServers
      const byName = servers !== undefined && servers.every((name) => SAFE_MCP_NAME.test(name))
      const unwatched =
        spec.remote !== undefined || spec.unattended === true
          ? [
              ...(byName
                ? servers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`])
                : ["--ignore-user-config"]),
              "-c",
              'web_search="disabled"',
              "-c",
              "features.apps=false",
              "-c",
              "features.plugins=false",
              ...CODEX_PROJECT_ONLY,
            ]
          : []
      if (sessionId) {
        return {
          command: runner.command,
          // `--` first: a message that starts with `-` is a message, not an option.
          args: [
            "exec",
            "resume",
            "--json",
            "--skip-git-repo-check",
            ...unwatched,
            ...model,
            ...config,
            "--",
            sessionId,
            notStdin(message),
          ],
          ...where,
          ...accountLaunch(spec.account),
        }
      }
      return {
        command: runner.command,
        args: [
          "exec",
          "--json",
          "--skip-git-repo-check",
          ...unwatched,
          ...model,
          ...config,
          "--",
          notStdin(withInstructions(bot, message)),
        ],
        ...where,
        ...accountLaunch(spec.account),
      }
    }
  }
}

/* ── what comes back ────────────────────────────────────────────────────── */

export function applyRunnerLine(runner: Runner, talk: Talk, line: string, at: number): Talk {
  switch (runner.id) {
    case "ragu":
      // Its events come from ADE's server (`serve-turn.ts`), never as lines.
      return talk
    case "claude":
      return applyJsonLine(talk, line, at, applyClaudeEvent)
    case "codex":
      return applyJsonLine(talk, line, at, applyCodexEvent)
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const rec = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function withSession(talk: Talk, id: unknown): Talk {
  const sessionId = str(id)
  return sessionId && !talk.sessionId ? { ...talk, sessionId } : talk
}

/** A tool's input in one line: the command, the path, or the object. */
function describeInput(input: unknown): string {
  const record = rec(input)
  if (!record) return typeof input === "string" ? input : ""
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const value = str(record[key])
    if (value) return value
  }
  return Object.keys(record).length > 0 ? JSON.stringify(record) : ""
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  return list(content)
    .map((part) => str(rec(part)?.["text"]) ?? "")
    .filter(Boolean)
    .join("\n")
}

/** Only the counters a bill counts; Claude's usage also carries tiers and nested diagnostics. */
function claudeTokens(usage: unknown): number {
  const record = rec(usage)
  if (!record) return 0
  let total = 0
  for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) total += value
  }
  return total
}

/**
 * Claude Code's stream: `system/init` names the session, `assistant` messages
 * carry text and tool calls, `user` messages carry the tools' results, and
 * `result` closes the turn with its cost and whatever was refused.
 */
export function applyClaudeEvent(talk: Talk, event: Record<string, unknown>, at: number): Talk {
  let next = noteReportedModel(withSession(talk, event["session_id"]), event)
  const message = rec(event["message"])
  switch (event["type"]) {
    case "stream_event": {
      // A subagent's text is not the answer.
      if (event["parent_tool_use_id"]) return next
      const inner = rec(event["event"])
      if (inner?.["type"] === "content_block_start") return { ...next, streaming: "" }
      const delta = rec(inner?.["delta"])
      if (inner?.["type"] !== "content_block_delta" || delta?.["type"] !== "text_delta") return next
      return { ...next, streaming: (next.streaming ?? "") + (str(delta["text"]) ?? "") }
    }
    case "assistant": {
      if (!event["parent_tool_use_id"]) next = { ...next, streaming: undefined }
      for (const raw of list(message?.["content"])) {
        const part = rec(raw)
        if (!part) continue
        if (part["type"] === "text") {
          const text = str(part["text"]) ?? ""
          if (text.trim()) next = appendMessage(next, { role: "bot", text }, at)
        } else if (part["type"] === "tool_use") {
          const tool = str(part["name"]) ?? "tool"
          const id = str(part["id"])
          next = appendMessage(
            next,
            { role: "tool", tool, text: describeInput(part["input"]) || tool, ...(id ? { id: `t-${id}` } : {}) },
            at,
          )
        }
      }
      return next
    }
    case "user": {
      for (const raw of list(message?.["content"])) {
        const part = rec(raw)
        if (part?.["type"] !== "tool_result") continue
        const id = str(part["tool_use_id"])
        if (id) next = attachOutput(next, `t-${id}`, contentText(part["content"]))
      }
      return next
    }
    case "result": {
      const cost = typeof event["total_cost_usd"] === "number" ? (event["total_cost_usd"] as number) : 0
      const tokens = claudeTokens(event["usage"])
      next = noteTurnUsage(
        { ...next, tokens: next.tokens + tokens, costUsd: next.costUsd + cost, ended: true },
        tokens,
        cost,
        true,
      )
      /*
       * A write refused by a path rule (`EXECUTES_LATER`, a project's bot) is
       * not a tool to enable in the card: it is refused on purpose (review
       * B7, BASSO 2). Told apart by what Claude Code answered the call.
       */
      /*
       * B8c: a command refused by the block list or as a danger
       * (`claudeRefusals`) says why; a danger offers «Sempre» for the next turn.
       */
      const approvalOf = (denial: Record<string, unknown> | undefined) => {
        const tool = str(denial?.["tool_name"])
        const command = str(rec(denial?.["tool_input"])?.["command"])
        if ((tool !== "Bash" && tool !== "PowerShell") || !command) return undefined
        const verdict = classifyCommand(command)
        return verdict.blocked || verdict.dangers.length > 0 ? { command, ...verdict } : undefined
      }
      const allDenials = list(event["permission_denials"]).map(rec)
      for (const denial of allDenials) {
        const found = approvalOf(denial)
        if (!found) continue
        if (found.blocked) {
          next = appendMessage(
            next,
            { role: "error", text: t("bots.approval.blocked", found.command, t(found.blocked.reason)) },
            at,
          )
        } else {
          const reason = found.dangers.map((rule) => t(rule.reason)).join("; ")
          next = appendMessage(next, { role: "error", text: t("bots.approval.refused", found.command, reason) }, at)
          // «Sempre» only when every danger may be kept (second review, BASSO 2).
          if (found.dangers.every((rule) => rule.always !== false))
            next = { ...next, offer: { always: found.dangers.map((rule) => rule.id), reason, command: found.command } }
        }
      }
      const denials = allDenials.filter((denial) => !approvalOf(denial))
      const onProtectedPath = (denial: Record<string, unknown> | undefined) => {
        const id = str(denial?.["tool_use_id"])
        const output = id ? next.messages.find((message) => message.id === `t-${id}`)?.output : undefined
        return output !== undefined && /denied by your permission settings/i.test(output)
      }
      const guarded = denials.filter(onProtectedPath)
      const others = denials.filter((denial) => !onProtectedPath(denial))
      if (guarded.length > 0) {
        next = appendMessage(
          next,
          {
            role: "error",
            text: t("bots.runner.protectedPath", EXECUTES_LATER.join(", ")),
          },
          at,
        )
      }
      if (others.length > 0) {
        const names = [...new Set(others.map((d) => str(d?.["tool_name"]) ?? "tool"))].join(", ")
        next = appendMessage(
          next,
          {
            role: "error",
            text: t("bots.runner.permissionDenied", names),
          },
          at,
        )
      }
      if (event["is_error"] === true) {
        const errors = list(event["errors"]).map(str).filter(Boolean).join("\n")
        /*
         * A conversation Claude Code no longer has — its transcript deleted,
         * or never written — cannot be resumed, and every later turn would
         * fail the same way. The id goes, so the next message starts afresh.
         */
        if (/No conversation found/i.test(errors)) {
          const { sessionId: _gone, ...rest } = next
          return {
            ...appendMessage(rest, { role: "error", text: t("bots.runner.conversationGone") }, at),
            status: "error",
          }
        }
        const text = str(event["result"]) || errors || str(event["subtype"]) || t("bots.runner.claudeError")
        next = { ...appendMessage(next, { role: "error", text }, at), status: "error" }
      }
      return next
    }
    default:
      return next
  }
}

function codexTokens(usage: unknown): number {
  const record = rec(usage)
  if (!record) return 0
  const input = typeof record["input_tokens"] === "number" ? (record["input_tokens"] as number) : 0
  const output = typeof record["output_tokens"] === "number" ? (record["output_tokens"] as number) : 0
  return input + output
}

/**
 * Codex's `exec --json`: `thread.started` names the thread, completed items
 * are the agent's messages and the commands and edits it made, and
 * `turn.completed` carries the usage.
 */
export function applyCodexEvent(talk: Talk, event: Record<string, unknown>, at: number): Talk {
  const next = noteReportedModel(withSession(talk, event["thread_id"]), event)
  switch (event["type"]) {
    case "item.completed": {
      const item = rec(event["item"])
      if (!item) return next
      switch (item["type"]) {
        case "agent_message": {
          const text = str(item["text"]) ?? ""
          return text.trim() ? appendMessage(next, { role: "bot", text }, at) : next
        }
        case "command_execution": {
          const output = str(item["aggregated_output"])
          return appendMessage(
            next,
            {
              role: "tool",
              tool: "shell",
              text: str(item["command"]) ?? t("bots.runner.command"),
              ...(output?.trim() ? { output } : {}),
            },
            at,
          )
        }
        case "file_change": {
          const paths = list(item["changes"])
            .map((c) => str(rec(c)?.["path"]))
            .filter(Boolean)
            .join(", ")
          return appendMessage(next, { role: "tool", tool: "edit", text: paths || t("bots.runner.edit") }, at)
        }
        case "mcp_tool_call": {
          const tool = [str(item["server"]), str(item["tool"])].filter(Boolean).join(".") || "mcp"
          return appendMessage(next, { role: "tool", tool, text: describeInput(item["arguments"]) || tool }, at)
        }
        case "web_search":
          return appendMessage(
            next,
            { role: "tool", tool: "web", text: str(item["query"]) ?? t("bots.runner.search") },
            at,
          )
        default:
          return next
      }
    }
    case "turn.completed": {
      /* `cached_input_tokens` is part of `input_tokens`, not on top of it. */
      const tokens = codexTokens(event["usage"])
      return noteTurnUsage({ ...next, tokens: next.tokens + tokens, ended: true }, tokens, 0, true)
    }
    case "turn.failed":
    case "error": {
      const text = errorText(event["error"] ?? event["message"] ?? event)
      // Codex says a failure twice, as `error` and then `turn.failed`: once on the thread is enough.
      const last = next.messages.at(-1)
      const said = last?.role === "error" && last.text === text
      const failed = {
        ...(said ? next : appendMessage(next, { role: "error", text }, at)),
        status: "error" as const,
        ...(event["type"] === "turn.failed" ? { ended: true } : {}),
      }
      return event["type"] === "turn.failed" ? sealTurn(failed) : failed
    }
    default:
      return next
  }
}

/**
 * The answer a turn gave, for a caller that wants words rather than a thread:
 * the bot's messages after the last thing the user said, joined. Tool calls
 * and errors are not the answer.
 */
export function finalText(talk: Talk): string {
  const lastUser = talk.messages.map((message) => message.role).lastIndexOf("user")
  return talk.messages
    .slice(lastUser + 1)
    .filter((message) => message.role === "bot")
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join("\n\n")
}

/**
 * The answer so far, while it is being written: `finalText` and the message
 * still arriving. Each call extends the last one, until a message is complete.
 */
export function answerSoFar(talk: Talk): string {
  const done = finalText(talk)
  const writing = talk.streaming?.trim() ? talk.streaming.trimStart() : ""
  if (!writing) return done
  return done ? `${done}\n\n${writing}` : writing
}

/* ── signed in or not ───────────────────────────────────────────────────── */

export interface LoginState {
  readonly state: "in" | "out" | "unknown"
  readonly detail: string
}

/** What a runner's status command printed, read as signed in or not. */
export function readLoginStatus(runner: Runner, output: string, code: number | null): LoginState {
  const text = stripAnsi(output).split(String.fromCharCode(13)).join("").trim()
  const first = text.split("\n")[0]?.trim() ?? ""
  switch (runner.id) {
    case "claude": {
      try {
        const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>
        if (parsed["loggedIn"] === true) {
          const method = str(parsed["authMethod"])
          return {
            state: "in",
            detail:
              method === "claude.ai"
                ? t("bots.login.claudePlan")
                : method
                  ? t("bots.login.method", method)
                  : t("bots.login.done"),
          }
        }
        return { state: "out", detail: t("bots.login.out") }
      } catch {
        return { state: "unknown", detail: first || t("bots.login.unreadable") }
      }
    }
    case "codex": {
      const line = text.split("\n").find((l) => /logged in/i.test(l))
      if (line && !/not logged in/i.test(line)) {
        const using = /^Logged in using (.*)$/i.exec(line.trim())
        return { state: "in", detail: using ? t("bots.login.usingMethod", using[1] ?? "") : line.trim() }
      }
      return { state: line ? "out" : code === 0 ? "unknown" : "out", detail: first || t("bots.login.out") }
    }
    case "ragu": {
      const providers = text
        .split("\n")
        .map((l) => l.replace(/[│┌└●○◇◆]/g, "").trim())
        .filter((l) => /\s(oauth|api|wellknown)\s*$/i.test(l))
        .map((l) => l.replace(/\s+(oauth|api|wellknown)\s*$/i, "").trim())
        .filter(Boolean)
      if (providers.length > 0) return { state: "in", detail: providers.join(", ") }
      /* "0 credentials" is an answer; a crash before the list is not one. */
      if (/\b0 credentials\b/i.test(text)) return { state: "out", detail: t("bots.login.noProvider") }
      return { state: "unknown", detail: first || t("bots.login.unreadable") }
    }
  }
}
