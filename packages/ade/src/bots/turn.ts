/**
 * One turn on a runner, outside the Bot view.
 *
 * For callers that want an answer rather than a thread on screen: the voice
 * agent hands over what the local grammar could not do, and reads the answer
 * aloud. Same runners and adapters as a bot conversation (`runners.ts`), so a
 * turn here is exactly a bot turn: Claude Code with the user's Anthropic
 * subscription, Codex with ChatGPT, nikcli with its providers.
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
import { registerSender, unregisterSender } from "../session/senders"
import { acquireTurn } from "./terms"
import type { AgentFile } from "./nikcli"
import { applyRunnerLine, enforcesDisabledTools, finalText, runnerById, turnCommand, type RunnerId } from "./runners"
import { applyExit, applyProblem, emptyTalk, sendMessage, type Talk } from "./talk"

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
  /** Every change to the turn as it happens: tool calls, partial text, a permission question. */
  readonly onUpdate?: (talk: Talk) => void
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
  /** Everything that happened, message by message. */
  readonly talk: Talk
}

export interface Turn {
  readonly result: Promise<TurnResult>
  /** Ends the turn early; the result resolves as `stopped`. */
  readonly stop: () => void
}

export function runTurn(request: TurnRequest): Turn {
  const runner = runnerById(request.runner)
  let stopped = false
  let kill: (() => void) | undefined

  const result = (async (): Promise<TurnResult> => {
    let talk = sendMessage(emptyTalk(), request.message, Date.now())
    const update = (next: Talk) => {
      talk = next
      request.onUpdate?.(talk)
    }
    const finish = (status: TurnResult["status"], problem?: string): TurnResult => ({
      status,
      text: finalText(talk),
      ...(talk.sessionId ? { sessionId: talk.sessionId } : {}),
      tokens: talk.tokens,
      costUsd: talk.costUsd,
      ...(problem ? { problem } : {}),
      talk,
    })

    const host = await getHost()
    if (!host?.spawn) {
      update(applyProblem(talk, "Nessun host: un turno si esegue solo nell'app desktop.", Date.now()))
      return finish("error", talk.problem)
    }

    const bot: AgentFile = {
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
    if (bot.disabledTools.length > 0 && !enforcesDisabledTools(runner.id)) {
      const problem = `${runner.label} non può rifiutare gli strumenti che questo turno esclude.`
      update(applyProblem(talk, problem, Date.now()))
      return finish("error", problem)
    }
    const outbox = request.mailbox ? await host.mailboxOutbox?.().catch(() => undefined) : undefined
    const { command, args, cwd } = turnCommand(runner, {
      bot,
      message: request.message,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.lean ? { lean: true } : {}),
      ...(outbox ? { outbox } : {}),
    })
    const spawnCwd = cwd ?? request.cwd

    const slot = acquireTurn(runner.id, runner.label)
    if ("problem" in slot) {
      update(applyProblem(talk, slot.problem, Date.now()))
      return finish("error", slot.problem)
    }

    const token = request.mailbox ? crypto.randomUUID() : undefined
    if (request.mailbox && token) registerSender(request.mailbox.id, token)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        host
          .spawn({
            command,
            args,
            ...(spawnCwd ? { cwd: spawnCwd } : {}),
            cols: 400,
            rows: 50,
            ...(request.mailbox && token ? { pane: request.mailbox.id, paneToken: token } : {}),
            onLine: (line) => update(applyRunnerLine(runner, talk, line, Date.now())),
            onExit: resolve,
          })
          .then((session) => {
            kill = () => session.kill()
            if (stopped) session.kill()
          })
          .catch(reject)
      })
      update(applyExit(talk, code, Date.now(), runner.label))
      if (stopped) return finish("stopped")
      return talk.status === "error" ? finish("error", talk.messages.at(-1)?.text) : finish("done")
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error)
      update(applyProblem(talk, `${runner.label} non si avvia: ${said}`, Date.now()))
      return finish("error", talk.problem)
    } finally {
      slot.release()
      if (request.mailbox && token) unregisterSender(request.mailbox.id, token)
    }
  })()

  return {
    result,
    stop: () => {
      stopped = true
      kill?.()
    },
  }
}
