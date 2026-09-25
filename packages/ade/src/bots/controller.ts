/**
 * The Bots panel's running turns, without the panel (B2, audit A2 and A3).
 *
 * One turn per bot, through `runTurn`: the same process life the voice's
 * turns have. A stop kills the CLI with its children and still ends the
 * turn, so the plan's place (`terms.ts`) comes back and the thread returns
 * to idle; a runner that does not start says so in the thread. Before, the
 * panel started its own process and waited for an exit that a killed
 * session never reports: the bot stayed «working», the next message went
 * nowhere, and after three stops the voice was refused as well.
 *
 * What the CLI writes is folded into the panel's own thread (`update`), not
 * into the throwaway one `runTurn` keeps. A turn that is stopped or
 * forgotten is left behind: whatever it still says goes nowhere.
 */

import type { AgentFile } from "./nikcli"
import { applyRunnerLine, runnerById } from "./runners"
import { answerKeys, applyExit, applyProblem, noticePermission, permissionAnswered, sendMessage, emptyTalk, type PermissionAnswer, type Talk } from "./talk"
import type { Turn, TurnRequest } from "./turn"

/**
 * How long a bot's turn may run. Longer than a spoken turn's five minutes:
 * a bot may be asked to write code. Still bounded, so a CLI that hangs gives
 * its place back.
 */
export const BOT_TURN_TIMEOUT_MS = 30 * 60_000

export interface BotTurnsDeps {
  readonly runTurn: (request: TurnRequest) => Turn
  readonly talkOf: (path: string) => Talk
  readonly update: (path: string, change: (talk: Talk) => Talk) => void
}

export interface BotTurns {
  /** Starts a turn of `bot` on `message`; false when one is already running. */
  send: (bot: AgentFile, message: string, cwd?: string) => boolean
  answer: (bot: AgentFile, choice: PermissionAnswer) => void
  /** «Ferma»: the turn ends, with its child processes; the thread stays. */
  stop: (bot: AgentFile) => void
  /** «Nuova conversazione»: the turn ends and the thread starts over, session id included. */
  forget: (bot: AgentFile) => void
  running: (path: string) => boolean
}

export function createBotTurns(deps: BotTurnsDeps): BotTurns {
  const turns = new Map<string, Turn>()

  const send = (bot: AgentFile, message: string, cwd?: string): boolean => {
    const path = bot.path
    if (turns.has(path)) return false
    const runner = runnerById(bot.runner)
    deps.update(path, (talk) => sendMessage(talk, message, Date.now()))
    const sessionId = deps.talkOf(path).sessionId
    const current = () => turns.get(path) === turn
    const turn = deps.runTurn({
      runner: runner.id,
      bot,
      message,
      ...(sessionId ? { sessionId } : {}),
      ...(cwd ? { cwd } : {}),
      // A bot's turn is ADE's, not the user's: no user MCP, settings or memory (S13).
      lean: true,
      timeoutMs: BOT_TURN_TIMEOUT_MS,
      onLine: (line) => {
        if (current()) deps.update(path, (talk) => applyRunnerLine(runner, talk, line, Date.now()))
      },
      /* Only nikcli draws a permission menu; the others decide up front. */
      onData: (chunk) => {
        if (current() && runner.id === "nikcli") deps.update(path, (talk) => noticePermission(talk, chunk, Date.now()))
      },
    })
    turns.set(path, turn)
    void turn.result.then((result) => {
      if (!current()) return
      turns.delete(path)
      const at = Date.now()
      deps.update(path, (talk) => {
        if (result.status === "stopped") return applyExit(talk, null, at, runner.label)
        if (result.exitCode !== undefined) return applyExit(talk, result.exitCode, at, runner.label, result.lastWords)
        return applyProblem(talk, result.problem ?? `${runner.label} non ha risposto.`, at)
      })
    })
    return true
  }

  /** Ends the turn of `path`, if any, and forgets it: what it still says goes nowhere. */
  const end = (path: string): Turn | undefined => {
    const turn = turns.get(path)
    if (!turn) return undefined
    turns.delete(path)
    turn.stop()
    return turn
  }

  return {
    send,
    answer: (bot, choice) => {
      const turn = turns.get(bot.path)
      if (!turn) return
      turn.write?.(answerKeys(choice))
      deps.update(bot.path, (talk) => permissionAnswered(talk, Date.now()))
    },
    stop: (bot) => {
      if (!end(bot.path)) return
      deps.update(bot.path, (talk) => applyExit(talk, null, Date.now(), runnerById(bot.runner).label))
    },
    forget: (bot) => {
      end(bot.path)
      deps.update(bot.path, () => emptyTalk())
    },
    running: (path) => turns.has(path),
  }
}
