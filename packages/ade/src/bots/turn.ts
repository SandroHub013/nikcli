/**
 * One turn on a runner, outside the Bot view.
 *
 * For callers that want an answer rather than a thread on screen: the voice
 * agent hands over what the local grammar could not do, and reads the answer
 * aloud. Same runners and adapters as a bot conversation (`runners.ts`), so a
 * turn here is exactly a bot turn: Claude Code with the user's Anthropic
 * subscription, Codex with ChatGPT. A nikcli bot's turn runs on ADE's nikcli
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
import type { AgentFile } from "./nikcli"
import { applyRunnerLine, enforcesDisabledTools, finalText, runnerById, spendKind, turnCommand, type RemoteTools, type RunnerId } from "./runners"
import { applyExit, applyProblem, emptyTalk, sendMessage, type PendingPermission, type Talk } from "./talk"

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
  /** nikcli only: the agent file to run as. Absent: nikcli's default agent. */
  readonly agent?: string
  /** Tools to refuse, as nikcli names them (`bash`, `edit`, `write`…). */
  readonly disabledTools?: readonly string[]
  /** Give the turn an `ade-msg` identity. `id` must be unique while the turn runs. */
  readonly mailbox?: { readonly id: string }
  /** Faster Claude Code turn: no MCP servers, no user settings files, ade-msg still allowed. See `TurnSpec.lean`. */
  readonly lean?: boolean
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
  /** The caller answers every question nikcli asks (B8c, `TurnSpec.approvals`). */
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
   * nikcli on ADE's server (B8d): each change the turn makes to a thread, as
   * it happens, for the caller to make to its own. Not the user's message,
   * which the caller put there already.
   */
  readonly onChange?: (change: (talk: Talk) => Talk) => void
  /**
   * nikcli on ADE's server (B8d): a question to answer with `Turn.answer`,
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
  /** The answer to the question `onPermission` gave: nikcli on ADE's server (B8d). */
  readonly answer?: (reply: "once" | "reject") => void
}

/* See `@nikcli-ai/voice` `timing.ts`: a no-op unless a harness is measuring. */
export function markTurn(mark: string, detail?: string): void {
  const timeline = (globalThis as { __adeVoiceTimeline?: Array<{ at: number; mark: string; detail?: string }> }).__adeVoiceTimeline
  if (Array.isArray(timeline)) timeline.push({ at: Date.now(), mark, ...(detail ? { detail } : {}) })
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
    if (runner.id === "nikcli") {
      update(applyProblem(talk, t("bots.turn.nikcliOnServer"), Date.now()))
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
    // The same mailbox mailbox.rs uses, per worktree in ADE Test (`ADE_MAILBOX_ROOT`).
    const mailbox = request.mailbox ? await host.mailboxDir?.().catch(() => undefined) : undefined
    const outbox = mailbox ? `${mailbox.replace(/[\\/]+$/, "")}/outbox` : undefined
    const { command, args, cwd, flags, secrets } = turnCommand(runner, {
      bot,
      message: request.message,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.lean ? { lean: true } : {}),
      ...(request.partial ? { partial: true } : {}),
      ...(outbox ? { outbox } : {}),
      ...(request.remote ? { remote: request.remote } : {}),
      ...(request.account ? { account: request.account } : {}),
      ...(request.approvals ? { approvals: true } : {}),
      ...(request.always ? { always: request.always } : {}),
      ...(request.unattended ? { unattended: true } : {}),
      ...(request.maxCostUsd !== undefined ? { maxBudgetUsd: request.maxCostUsd } : {}),
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
              if (plain && !before.partial && !talk.partial && !plain.startsWith("{")) lastWords = scrubSecrets(plain).slice(0, 300)
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
        const usd = (value: number) => `${value.toFixed(2)} $`
        const problem = t("bots.turn.overBudget", runner.label, usd(talk.costUsd), usd(request.maxCostUsd ?? 0))
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
      return talk.status === "error" ? finish("error", talk.messages.at(-1)?.text, code) : finish("done", undefined, code)
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
