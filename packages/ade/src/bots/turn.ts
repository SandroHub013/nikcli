/**
 * One turn on a runner, outside the Bot view.
 *
 * For callers that want an answer rather than a thread on screen: the voice
 * agent hands over what the local grammar could not do, and reads the answer
 * aloud. Same runners and adapters as a bot conversation (`runners.ts`), so a
 * turn here is exactly a bot turn: Claude Code with the user's Anthropic
 * subscription, Codex with ChatGPT. A ragu bot's turn runs on ADE's ragu
 * server instead (`serve-turn.ts`, B8d), with its session's rules: here it is
 * refused.
 *
 * With `mailbox`, the process gets its own `ade-msg` identity for the length
 * of the turn (`session/senders.ts`), so it can list, ask, spawn and close
 * sessions. It has no terminal to be typed into, so answers must be awaited
 * with a blocking `ade-msg ask`; `instructions` is the place to say so.
 *
 * ```ts
 * const turn = runTurn({ runner: "claude", message: "apri una sessione codex sui test", mailbox: { id: "voce" } })
 * const { status, text } = await turn.result
 * ```
 */

import { getHost } from "../host/shell"
import { stripAnsi } from "../session/stream"
import { registerSender, unregisterSender } from "../session/senders"
import { t } from "../i18n"
import { acquireTurn, scrubSecrets } from "./terms"
import type { BotAccount } from "./account"
import { codexVersion } from "./codex-version"
import { formatCap, formatUsd } from "./format"
import type { AgentFile } from "./ragu"
import {
  applyRunnerLine,
  codexMcpNames,
  CODEX_PROFILES_SINCE,
  codexKnowsProfiles,
  codexOptionsRefused,
  codexSandboxCannotRead,
  enforcesDisabledTools,
  finalText,
  runnerById,
  spendKind,
  turnCommand,
  type RemoteTools,
  type RunnerId,
} from "./runners"
import {
  appendMessage,
  applyExit,
  applyProblem,
  emptyTalk,
  sendMessage,
  type PendingPermission,
  type Talk,
} from "./talk"

export interface TurnRequest {
  readonly runner: RunnerId
  readonly message: string
  /** System prompt: who the agent is and how to behave. Claude Code gets it as a system prompt, the others before the message. */
  readonly instructions?: string
  readonly model?: string
  readonly effort?: string
  /** The conversation to continue, from a previous result. */
  readonly sessionId?: string
  readonly cwd?: string
  /** ragu only: the agent file to run as. Absent: ragu's default agent. */
  readonly agent?: string
  /** Tools to refuse, as ragu names them (`bash`, `edit`, `write`…). */
  readonly disabledTools?: readonly string[]
  /** Give the turn an `ade-msg` identity. `id` must be unique while the turn runs. */
  readonly mailbox?: { readonly id: string }
  /** Faster Claude Code turn: no MCP servers, no user settings files, ade-msg still allowed. See `TurnSpec.lean`. */
  readonly lean?: boolean
  /** No tool at all, not even `ade-msg` (`TurnSpec.noTools`). */
  readonly noTools?: boolean
  /**
   * ragu only: the model is one of these, chosen when the turn runs, and never a paid one. The user's own
   * configured model comes first when it is free; then the first the server's catalog has. None: the turn
   * is refused before any session.
   */
  readonly freeModels?: readonly string[]
  /** Claude Code only: the answer as it is written, through `onUpdate` (`Talk.streaming`). */
  readonly partial?: boolean
  /** Every change to the turn as it happens: tool calls, partial text, a permission question. */
  readonly onUpdate?: (talk: Talk) => void
  /** How long the turn may run before it is stopped with its child processes; `TURN_TIMEOUT_MS` when absent. */
  readonly timeoutMs?: number
  /** How long the CLI may take to exit after its final event before it is killed; `TURN_EXIT_GRACE_MS` when absent. */
  readonly exitGraceMs?: number
  /**
   * The Bots panel's own bot file, whole: its persona, tools and identifier
   * (B2). Absent: a bot made from `instructions`, `model`, `effort`, `agent`
   * and `disabledTools` above, as the voice asks for one.
   */
  readonly bot?: AgentFile
  /** Every line the CLI writes, as it comes: the panel folds them into its own thread. */
  readonly onLine?: (line: string) => void
  /** A turn from a chat, through a bot's gateway: its tools (G5, `RemoteTools`). */
  readonly remote?: RemoteTools
  /** Claude Code and Codex: subscription or one key name. Absent is a subscription. */
  readonly account?: BotAccount
  /** The caller answers every question ragu asks (B8c, `TurnSpec.approvals`). */
  readonly approvals?: boolean
  /** The bot's «Sempre», with `approvals` (`TurnSpec.always`). */
  readonly always?: readonly string[]
  /** Nobody watches the turn: no shell at all (B11, `TurnSpec.unattended`). */
  readonly unattended?: boolean
  /**
   * Dollars the turn may spend (B11, a routine's cap per run): past them it
   * is stopped at once, with its child processes, and says so. Claude Code
   * reports its cost only at the end, so it is told as well
   * (`TurnSpec.maxBudgetUsd`).
   */
  readonly maxCostUsd?: number
  /**
   * ragu on ADE's server (B8d): each change the turn makes to a thread, as
   * it happens, for the caller to make to its own. Not the user's message,
   * which the caller put there already.
   */
  readonly onChange?: (change: (talk: Talk) => Talk) => void
  /**
   * ragu on ADE's server (B8d): a question to answer with `Turn.answer`,
   * one at a time. Absent, every question is refused as it comes.
   */
  readonly onPermission?: (asked: PendingPermission) => void
  /** Someone is in front of the screen: a project not admitted yet is asked about, not refused (B8d). */
  readonly interactive?: boolean
}

/**
 * How long one turn may run.
 *
 * A turn waits on a CLI that can hang — a stuck network call, an `ade-msg ask`
 * whose session never answers (110 s each), a permission prompt nobody sees —
 * and whoever called it waits with it: the voice assistant stayed in
 * "executing" and kept one of the plan's parallel-turn slots (`terms.ts`).
 * Five minutes is above a turn that lists, asks and spawns, and below what a
 * person waits for a spoken answer before giving up on it.
 */
export const TURN_TIMEOUT_MS = 5 * 60_000

/**
 * How long a CLI may take to exit once its answer is complete.
 *
 * The turn ends at the final event, and the process is left to save and shut
 * down on its own, which takes under a second. One that hangs while closing
 * would stay alive with nobody waiting on it, so past this it is killed with
 * its children.
 */
export const TURN_EXIT_GRACE_MS = 10_000

/** What the caller is told when a turn ran out of time. */
export function timeoutProblem(label: string, timeoutMs: number): string {
  const minutes = timeoutMs / 60_000
  const span = Number.isInteger(minutes)
    ? `${minutes} ${t(minutes === 1 ? "bots.turn.minute" : "bots.turn.minutes")}`
    : `${Math.max(1, Math.round(timeoutMs / 1000))} ${t("bots.turn.seconds")}`
  return t("bots.turn.timeout", label, span)
}

/** What a turn needs from the app; the machine, passed in so a test can run one. */
export interface TurnDeps {
  readonly host?: () => ReturnType<typeof getHost>
  /** `codex --version`, for a Codex turn from a chat or a routine; by default asked once per start (`codex-version.ts`). */
  readonly codexVersion?: () => Promise<string | null>
}

export interface TurnResult {
  readonly status: "done" | "error" | "stopped"
  /** The agent's last answer, for reading aloud. Empty if it said nothing. */
  readonly text: string
  /** Pass back as `sessionId` to continue the conversation. */
  readonly sessionId?: string
  readonly tokens: number
  readonly costUsd: number
  /** Why it failed, when it did. */
  readonly problem?: string
  /** The plan's limit ended the turn. The voice reads this, not the sentence. */
  readonly limited?: boolean
  /**
   * How the process ended, when it ended on its own: its exit code, or 0 once
   * its final event arrived. Absent when it was stopped, ran out of time or
   * never started.
   */
  readonly exitCode?: number | null
  /** The CLI's last line that was not one of its events: on a failure, usually why. */
  readonly lastWords?: string
  /** Everything that happened, message by message. */
  readonly talk: Talk
}

export interface Turn {
  readonly result: Promise<TurnResult>
  /** Ends the turn early, with the CLI's child processes; the result resolves as `stopped`. */
  readonly stop: () => void
  /**
   * The answer to the question `onPermission` gave, by its id: ragu on ADE's
   * server (B8d). An answer to a question no longer on screen goes nowhere.
   */
  readonly answer?: (requestID: string, reply: "once" | "reject") => void
}

/* See `@ragu/voice` `timing.ts`: a no-op unless a harness is measuring. */
export function markTurn(mark: string, detail?: string): void {
  const timeline = (globalThis as { __adeVoiceTimeline?: Array<{ at: number; mark: string; detail?: string }> })
    .__adeVoiceTimeline
  if (Array.isArray(timeline)) timeline.push({ at: Date.now(), mark, ...(detail ? { detail } : {}) })
}

/** What a Codex turn nobody watches knows of the MCP servers its config brings. */
interface CodexMcp {
  /** The user's servers, to switch off by name; absent, the user's config.toml is left out whole. */
  readonly servers?: readonly string[]
  /** A project's `.codex/config.toml`, the reason the user's config is left out. */
  readonly projectConfig?: string
}

/** The folders from `cwd` up to its root, with `/`. */
function foldersUp(cwd: string): string[] {
  const parts = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/")
  const folders: string[] = []
  for (let count = parts.length; count > 0; count--) {
    const folder = parts.slice(0, count).join("/")
    if (folder) folders.push(folder)
  }
  return folders
}

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase()

/**
 * The MCP servers in the user's Codex config.toml (`~/.codex`), for a turn that switches them off by name: none when
 * there is no file; left out whole when it cannot be read or said for sure (`codexMcpNames`).
 *
 * Codex 0.162.1 also reads a project's `.codex/config.toml`, in a trusted project, in every folder from its git root
 * down to the turn's, with the MCP servers it names. Whether the project is trusted is not seen from here, and a
 * server switched off by name that Codex did not read stops the turn (`invalid transport`). So with such a file in
 * the turn's folder or above it, the user's config is left out, and the list of trusted projects with it: Codex then
 * reads no project's (both checked with a fake provider, no model turn).
 *
 * `CODEX_HOME` is not seen from here either: a Codex that reads another file refuses a server it does not have, and
 * the turn says why.
 */
async function codexMcpOf(host: NonNullable<Awaited<ReturnType<typeof getHost>>>, cwd: string | undefined) {
  try {
    const home = await host.homeDir?.()
    if (!home || !host.readTextFile || !host.exists) return {}
    const user = `${home.replace(/[\\/]+$/, "")}/.codex/config.toml`
    for (const folder of cwd ? foldersUp(cwd) : []) {
      const path = `${folder}/.codex/config.toml`
      if (!samePath(path, user) && (await host.exists(path))) return { projectConfig: path }
    }
    if (!(await host.exists(user))) return { servers: [] }
    const read = await host.readTextFile(user)
    const servers = read.truncated ? undefined : codexMcpNames(read.text)
    return servers ? { servers } : {}
  } catch {
    return {}
  }
}

export function runTurn(request: TurnRequest, deps: TurnDeps = {}): Turn {
  const runner = runnerById(request.runner)
  let stopped = false
  let kill: (() => void) | undefined
  /*
   * Ends the wait for the exit. A killed session unlistens before it could
   * report one, so a stopped or timed-out turn resolved here or never.
   */
  let settle: ((code: number | null) => void) | undefined

  const result = (async (): Promise<TurnResult> => {
    let talk = sendMessage(emptyTalk(), request.message, Date.now())
    const update = (next: Talk) => {
      talk = next
      request.onUpdate?.(talk)
    }
    let lastWords: string | undefined
    const finish = (status: TurnResult["status"], problem?: string, exitCode?: number | null): TurnResult => ({
      status,
      text: finalText(talk),
      ...(talk.sessionId ? { sessionId: talk.sessionId } : {}),
      tokens: talk.tokens,
      costUsd: talk.costUsd,
      ...(problem ? { problem } : {}),
      ...(talk.limited ? { limited: true } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(lastWords ? { lastWords } : {}),
      talk,
    })

    // Its rules are its session's on ADE's server, and nothing here would carry them (B8d).
    if (runner.id === "ragu") {
      update(applyProblem(talk, t("bots.turn.raguOnServer"), Date.now()))
      return finish("error", talk.problem)
    }
    const host = await (deps.host ?? getHost)()
    if (!host?.spawn) {
      update(applyProblem(talk, t("bots.turn.noHost"), Date.now()))
      return finish("error", talk.problem)
    }

    const bot: AgentFile = request.bot ?? {
      identifier: request.agent ?? "",
      path: "",
      scope: "global",
      description: "",
      mode: "primary",
      prompt: request.instructions ?? "",
      disabledTools: request.disabledTools ?? [],
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      runner: runner.id,
    }
    update({ ...talk, turnMode: spendKind(runner.id, bot.model, request.account) })
    if (bot.disabledTools.length > 0 && !enforcesDisabledTools(runner.id)) {
      const problem = t("bots.turn.cannotRefuse", runner.label)
      update(applyProblem(talk, problem, Date.now()))
      return finish("error", problem)
    }
    /*
     * Codex from a chat or in a routine: the user's MCP servers, read from its config.toml to be switched off by name
     * (the user's choice 7, `TurnSpec.codexMcpServers`). Unreadable, the turn leaves the whole file out.
     */
    const unwatchedCodex = runner.id === "codex" && (request.remote !== undefined || request.unattended === true)
    if (unwatchedCodex) {
      /*
       * Only a Codex that reads the project-only profile (bot-lettura-3): an older one would run with the read-only
       * sandbox, which reads the whole disk. A version that could not be read does not start either.
       */
      const version = await (deps.codexVersion ?? (() => codexVersion(host, runner.command)))()
      if (!codexKnowsProfiles(version)) {
        const found = /\d+\.\d+\.\d+/.exec(version ?? "")?.[0]
        const problem = found
          ? t("bots.codex.tooOld", CODEX_PROFILES_SINCE.join("."), found)
          : t("bots.codex.versionUnknown")
        update(applyProblem(talk, problem, Date.now()))
        return finish("error", problem)
      }
    }
    const codexMcp: CodexMcp = unwatchedCodex ? await codexMcpOf(host, request.cwd) : {}
    const codexMcpServers = codexMcp.servers
    // The same mailbox mailbox.rs uses, per worktree in ADE Test (`ADE_MAILBOX_ROOT`).
    const mailbox = request.mailbox ? await host.mailboxDir?.().catch(() => undefined) : undefined
    const outbox = mailbox ? `${mailbox.replace(/[\\/]+$/, "")}/outbox` : undefined
    const { command, args, cwd, flags, secrets } = turnCommand(runner, {
      bot,
      message: request.message,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.lean ? { lean: true } : {}),
      ...(request.noTools ? { noTools: true } : {}),
      ...(request.partial ? { partial: true } : {}),
      ...(outbox ? { outbox } : {}),
      ...(request.remote ? { remote: request.remote } : {}),
      ...(request.account ? { account: request.account } : {}),
      ...(request.approvals ? { approvals: true } : {}),
      ...(request.always ? { always: request.always } : {}),
      ...(request.unattended ? { unattended: true } : {}),
      ...(request.maxCostUsd !== undefined ? { maxBudgetUsd: request.maxCostUsd } : {}),
      ...(codexMcpServers ? { codexMcpServers } : {}),
    })
    const spawnCwd = cwd ?? request.cwd

    const slot = acquireTurn(runner.id, runner.label)
    if ("problem" in slot) {
      update(applyProblem(talk, slot.problem, Date.now()))
      return finish("error", slot.problem)
    }

    const token = request.mailbox ? crypto.randomUUID() : undefined
    if (request.mailbox && token) registerSender(request.mailbox.id, token)
    const timeoutMs = request.timeoutMs ?? TURN_TIMEOUT_MS
    let timedOut = false
    /* The turn spent more than `maxCostUsd`. */
    let overBudget = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let exited = false
    let lingering: ReturnType<typeof setTimeout> | undefined
    /*
     * What the host said when it could not start the CLI (audit A3): it
     * reports that as an "err" line and an exit, then hands back a session
     * anyway. Without this the turn ended «done» with nothing said.
     */
    let notStarted: string | undefined
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        settle = resolve
        timer = setTimeout(() => {
          timedOut = true
          kill?.()
          resolve(null)
        }, timeoutMs)
        host
          .spawn({
            command,
            args,
            ...(spawnCwd ? { cwd: spawnCwd } : {}),
            cols: 400,
            rows: 50,
            ...(request.mailbox && token ? { pane: request.mailbox.id, paneToken: token } : {}),
            ...(flags ? { flags } : {}),
            ...(secrets && secrets.length > 0 ? { secrets: [...secrets] } : {}),
            onLine: (line, stream) => {
              if (stream === "err") {
                notStarted = notStarted ? `${notStarted} ${line}` : line
                return
              }
              request.onLine?.(line)
              const before = talk
              update(applyRunnerLine(runner, talk, line, Date.now()))
              if (request.maxCostUsd !== undefined && !overBudget && talk.costUsd > request.maxCostUsd) {
                overBudget = true
                kill?.()
                resolve(null)
                return
              }
              // stderr shares the stream: an error the CLI printed is the last plain line (review B7, BASSO 3).
              const plain = stripAnsi(line).trim()
              // Scrub before the cut, so a key that runs past the 300th character is not sliced in half and kept.
              if (plain && !before.partial && !talk.partial && !plain.startsWith("{"))
                lastWords = scrubSecrets(plain).slice(0, 300)
              if (!before.sessionId && talk.sessionId) markTurn("cli-init")
              if (!before.streaming && talk.streaming) markTurn("cli-first-text")
              if (!before.ended && talk.ended) markTurn("cli-result")
              /*
               * The answer is complete at the CLI's final event. Waiting for the
               * process to exit as well cost ~0.7 s of saving and shutting down
               * on every spoken reply; the exit, when it comes, finds the wait
               * already over.
               */
              if (talk.ended && !lingering && !exited) {
                resolve(0)
                // Outlives the turn on purpose: see `TURN_EXIT_GRACE_MS`.
                lingering = setTimeout(() => {
                  if (!exited) kill?.()
                }, request.exitGraceMs ?? TURN_EXIT_GRACE_MS)
              }
            },
            onExit: (code) => {
              exited = true
              clearTimeout(lingering)
              resolve(code)
            },
          })
          .then((session) => {
            markTurn("cli-spawned")
            kill = () => session.kill({ tree: true })
            if (stopped || timedOut || overBudget) {
              kill()
              resolve(null)
            }
          })
          .catch(reject)
      })
      if (timedOut) {
        const problem = timeoutProblem(runner.label, timeoutMs)
        update(applyProblem(talk, problem, Date.now()))
        return finish("error", problem)
      }
      if (overBudget) {
        // In the language of ADE (D32): what it spent, then the cap.
        const problem = t(
          "bots.turn.overBudget",
          runner.label,
          formatUsd(talk.costUsd),
          formatCap(request.maxCostUsd ?? 0),
        )
        update(applyProblem(talk, problem, Date.now()))
        return finish("error", problem)
      }
      if (stopped) {
        update(applyExit(talk, code, Date.now(), runner.label))
        return finish("stopped")
      }
      if (notStarted !== undefined) {
        const problem = t("bots.turn.didNotStart", runner.label, notStarted)
        update(applyProblem(talk, problem, Date.now()))
        return finish("error", problem)
      }
      update(applyExit(talk, code, Date.now(), runner.label, lastWords))
      if (talk.status === "error" && unwatchedCodex) {
        /*
         * Why, when it is ADE's doing: a sandbox that cannot keep reads in the project (bot-lettura-2), options Codex
         * refused, or its config.toml left out (choice 7).
         */
        const why = codexSandboxCannotRead(lastWords)
          ? t("bots.codex.sandboxCannotRead")
          : codexOptionsRefused(lastWords)
            ? t("bots.codex.optionsRefused")
            : codexMcp.projectConfig
              ? t("bots.codex.projectConfig")
              : codexMcpServers === undefined
                ? t("bots.codex.withoutUserConfig")
                : undefined
        if (why) {
          const said = talk.messages.at(-1)?.text
          update(appendMessage(talk, { role: "error", text: why }, Date.now()))
          // The panel's thread shows a turn's end from its last words: the reason goes with them.
          lastWords = lastWords ? `${lastWords} ${why}` : why
          return finish("error", said ? `${said} ${why}` : why, code)
        }
      }
      return talk.status === "error"
        ? finish("error", talk.messages.at(-1)?.text, code)
        : finish("done", undefined, code)
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error)
      update(applyProblem(talk, t("bots.turn.didNotStart", runner.label, said), Date.now()))
      return finish("error", talk.problem)
    } finally {
      clearTimeout(timer)
      settle = undefined
      slot.release()
      if (request.mailbox && token) unregisterSender(request.mailbox.id, token)
    }
  })()

  return {
    result,
    stop: () => {
      stopped = true
      kill?.()
      settle?.(null)
    },
  }
}
