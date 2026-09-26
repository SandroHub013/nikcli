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

import { t } from "../i18n"
import type { BotAccount } from "./account"
import { APPROVAL_TIMEOUT_MS, decide, localAlwaysStore, type AlwaysStore } from "./approval"
import {
  memoryPreface,
  settleMemoryOps,
  takeMemoryOps,
  undoMemoryWrite,
  type MemoryOp,
  type MemoryStore,
} from "./memory"
import type { AgentFile } from "./nikcli"
import type { RoutineRun } from "./routine"
import { applyRunnerLine, runnerById, spendKind } from "./runners"
import {
  answerKeys,
  appendMessage,
  applyExit,
  applyProblem,
  noticePermission,
  permissionMenuReader,
  permissionAnswered,
  sendMessage,
  emptyTalk,
  type PendingPermission,
  type PermissionAnswer,
  type Talk,
} from "./talk"
import type { Turn, TurnRequest } from "./turn"

/**
 * How long a bot's turn may run. Longer than a spoken turn's five minutes:
 * a bot may be asked to write code. Still bounded, so a CLI that hangs gives
 * its place back.
 */
export const BOT_TURN_TIMEOUT_MS = 30 * 60_000

export interface BotTurnsDeps {
  readonly runTurn: (request: TurnRequest) => Turn
  /** A routine's run (B11): `runRoutine`, which asks the list again at spawn. Absent, `runTurn`. */
  readonly runRoutine?: (request: TurnRequest, run: RoutineRun) => Turn
  readonly talkOf: (path: string) => Talk
  readonly update: (path: string, change: (talk: Talk) => Talk) => void
  /** The bot's account in ADE. Absent is a subscription. */
  readonly accountOf?: (path: string) => BotAccount
  /** Each bot's «Sempre» (B8c). */
  readonly always?: AlwaysStore
  /** Each bot's memory (B8a); absent, the bots have none. */
  readonly memory?: MemoryStore
  /** Runs `run` after `ms`; the function returned cancels it. For tests. */
  readonly schedule?: (run: () => void, ms: number) => () => void
  readonly now?: () => number
}

export interface BotTurns {
  /** Starts a turn of `bot` on `message`; false when one is already running. */
  send: (bot: AgentFile, message: string, cwd?: string) => boolean
  /**
   * A routine's run of `bot` (B11), in its thread like any other turn, but
   * with nobody to answer: no shell, whatever the bot may do in the panel
   * and read-only (`bot-read-only` on nikcli, no Bash, Edit or Write for
   * Claude Code, Codex read-only).
   * Undefined when the bot already has a turn.
   */
  routine: (bot: AgentFile, message: string, cwd?: string, run?: RoutineRun) => Turn | undefined
  /**
   * The user's answer to the question on screen: Consenti (`once`), Nega
   * (`reject`), or Sempre (`always`), which is ADE's for this bot and goes to
   * nikcli as a once: nikcli's own «always» is the project's, every bot's.
   */
  answer: (bot: AgentFile, choice: PermissionAnswer) => void
  /**
   * «Annulla» on a memory line of the thread (B8a review): the write taken
   * back, while its block is as the write left it; the line says what came of it.
   */
  undoMemory: (bot: AgentFile, messageId: string) => void
  /** «Sempre per questo bot» on a command Claude Code was refused (`Talk.offer`): allowed from the next turn. */
  grant: (bot: AgentFile) => void
  /** «Ferma»: the turn ends, with its child processes; the thread stays. */
  stop: (bot: AgentFile) => void
  /** «Nuova conversazione»: the turn ends and the thread starts over, session id included. */
  forget: (bot: AgentFile) => void
  running: (path: string) => boolean
}

export function createBotTurns(deps: BotTurnsDeps): BotTurns {
  const turns = new Map<string, Turn>()
  const always = deps.always ?? localAlwaysStore()
  const now = deps.now ?? Date.now
  const schedule =
    deps.schedule ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    })
  /** The Nega waiting on each bot's open question. */
  const expiries = new Map<string, () => void>()
  const cancelExpiry = (path: string) => {
    expiries.get(path)?.()
    expiries.delete(path)
  }

  /** Answers nikcli's menu and closes the question; a line in the thread when there is something to say. */
  const reply = (path: string, turn: Turn, answer: "once" | "reject", line?: string) => {
    cancelExpiry(path)
    turn.write?.(answerKeys(answer))
    const at = now()
    deps.update(path, (talk) => {
      const answered = permissionAnswered(talk, at)
      return line ? appendMessage(answered, { role: "error", text: line }, at) : answered
    })
  }

  /**
   * A question nikcli just asked (B8c): the block list refuses it, the bot's
   * «Sempre» or an everyday command lets it through, and anything else stays
   * on screen with Consenti, Nega and Sempre, until it expires as a Nega.
   */
  const settle = (bot: AgentFile, turn: Turn, asked: PendingPermission) => {
    const path = bot.path
    const verdict = decide(asked.permission, asked.patterns, always.get(path), asked.cut === true)
    if (verdict.kind === "block")
      return reply(path, turn, "reject", t("bots.approval.blocked", asked.patterns, t(verdict.rule.reason)))
    if (verdict.kind === "allow") return reply(path, turn, "once")
    const expiresAt = asked.askedAt + APPROVAL_TIMEOUT_MS
    deps.update(path, (talk) =>
      talk.permission === asked
        ? {
            ...talk,
            permission: {
              ...asked,
              reason: verdict.reason,
              ...(verdict.keys ? { always: verdict.keys } : {}),
              ...(verdict.denyOnly ? { denyOnly: true } : {}),
              expiresAt,
            },
          }
        : talk,
    )
    cancelExpiry(path)
    expiries.set(
      path,
      schedule(() => {
        expiries.delete(path)
        const still = deps.talkOf(path).permission
        if (turns.get(path) !== turn || still?.askedAt !== asked.askedAt) return
        reply(path, turn, "reject", t("bots.approval.expired", asked.patterns))
      }, APPROVAL_TIMEOUT_MS),
    )
  }

  const begin = (bot: AgentFile, message: string, cwd: string | undefined, routine: RoutineRun | undefined): Turn | undefined => {
    const path = bot.path
    if (turns.has(path)) return undefined
    const runner = runnerById(bot.runner)
    const account = deps.accountOf?.(path) ?? { mode: "plan" as const }
    deps.update(path, (talk) => {
      // An offer from the last turn is not for this one.
      const { offer: _stale, ...rest } = talk
      const marked = routine ? appendMessage(rest, { role: "tool", tool: "ade", text: t("bots.routine.thread") }, Date.now()) : rest
      return { ...sendMessage(marked, message, Date.now()), turnMode: spendKind(runner.id, bot.model, account) }
    })
    const sessionId = deps.talkOf(path).sessionId
    /*
     * The bot's memory (B8a): its snapshot opens a conversation and nothing
     * after, so it stays as it was until the next one; what the last writes
     * came to is said once, on the turn after them.
     */
    const memory = deps.memory?.get(path)
    const preface = memory ? memoryPreface(memory, !sessionId) : ""
    if (memory?.pending && deps.memory) {
      const { pending: _told, ...kept } = memory
      deps.memory.set(path, kept)
    }
    const sent = preface ? `${preface}\n\n${message}` : message
    /* The thread's messages from here on are this turn's. */
    const from = deps.talkOf(path).messages.length
    const current = () => turns.get(path) === turn
    const readMenu = permissionMenuReader({
      schedule,
      onMenu: (seen) => {
        if (!current()) return
        const before = deps.talkOf(path).permission
        deps.update(path, (talk) => noticePermission(talk, seen, now()))
        const asked = deps.talkOf(path).permission
        if (!asked || asked === before) return
        /*
         * Nobody is there to answer a routine (B11 review, BASSO 1): whatever
         * nikcli asks is refused at once, not left on a menu until the turn
         * runs out of time.
         */
        if (routine) return reply(path, turn, "reject", t("bots.routine.refused", asked.permission, asked.patterns))
        settle(bot, turn, asked)
      },
    })
    const request: TurnRequest = {
      runner: runner.id,
      bot,
      message: sent,
      account,
      ...(sessionId ? { sessionId } : {}),
      ...(cwd ? { cwd } : {}),
      // A bot's turn is ADE's, not the user's: no user MCP, settings or memory (S13).
      lean: true,
      // nikcli asks, `settle` answers; Claude Code is refused what the bot's «Sempre» does not cover (B8c).
      // A routine has nobody to answer: no approvals, and no shell (`TurnSpec.unattended`).
      ...(routine ? { unattended: true } : { approvals: true, always: always.get(path) }),
      // A routine's cap per run holds during the turn, not after it (B11 review, M1).
      ...(routine?.maxCostUsd !== undefined ? { maxCostUsd: routine.maxCostUsd } : {}),
      timeoutMs: BOT_TURN_TIMEOUT_MS,
      onLine: (line) => {
        if (current()) deps.update(path, (talk) => applyRunnerLine(runner, talk, line, Date.now()))
      },
      /* Only nikcli draws a permission menu, read whole (M1); the others decide up front. */
      onData: (chunk) => {
        if (current() && runner.id === "nikcli") readMenu(chunk)
      },
    }
    const turn = routine && deps.runRoutine ? deps.runRoutine(request, routine) : deps.runTurn(request)
    turns.set(path, turn)
    void turn.result.then((result) => {
      if (!current()) return
      settleMemory(path, from)
      turns.delete(path)
      cancelExpiry(path)
      const at = Date.now()
      deps.update(path, (talk) => {
        if (result.status === "stopped") return applyExit(talk, null, at, runner.label)
        if (result.exitCode !== undefined) return applyExit(talk, result.exitCode, at, runner.label, result.lastWords)
        return applyProblem(talk, result.problem ?? `${runner.label} non ha risposto.`, at)
      })
    })
    return turn
  }

  const send = (bot: AgentFile, message: string, cwd?: string): boolean => begin(bot, message, cwd, undefined) !== undefined

  /**
   * The memory tags in what the bot said this turn: taken out of its words,
   * applied in order, and each outcome a line in the thread. What failed
   * reaches the bot at the start of its next turn (`memoryPreface`).
   */
  const settleMemory = (path: string, from: number) => {
    const store = deps.memory
    if (!store) return
    const said = deps
      .talkOf(path)
      .messages.slice(from)
      .filter((message) => message.role === "bot")
    const texts = new Map<string, string>()
    const ops: MemoryOp[] = []
    let unreadable = 0
    for (const message of said) {
      const taken = takeMemoryOps(message.text)
      if (taken.ops.length === 0 && taken.unreadable === 0) continue
      texts.set(message.id, taken.text)
      ops.push(...taken.ops)
      unreadable += taken.unreadable
    }
    if (texts.size === 0) return
    /*
     * The user's profile is the block the model believes most: a write to it
     * waits for the user's click in the Memoria section (B8a review).
     */
    const { memory, lines } = settleMemoryOps(store.get(path), ops, () => crypto.randomUUID(), {
      propose: (op) => op.block === "user",
      from: "panel",
      at: now(),
    })
    // The bot hears of what failed, and of what waits for the user.
    const failures = lines.flatMap((line) => (!line.ok || line.proposal ? [line.text] : []))
    if (unreadable > 0) failures.push(t("bots.memory.error.unreadable", unreadable))
    store.set(path, { ...memory, ...(failures.length > 0 ? { pending: failures } : {}) })
    const at = now()
    deps.update(path, (talk) => {
      const messages = talk.messages
        .map((message) => (texts.has(message.id) ? { ...message, text: texts.get(message.id)! } : message))
        .filter((message) => !(texts.has(message.id) && message.text.length === 0))
      let next: Talk = { ...talk, messages }
      for (const line of lines) {
        next = appendMessage(
          next,
          line.ok
            ? { role: "tool", tool: "ade", text: line.text, ...(line.undo ? { memoryUndo: line.undo } : {}) }
            : { role: "error", text: line.text },
          at,
        )
      }
      if (unreadable > 0)
        next = appendMessage(next, { role: "error", text: t("bots.memory.error.unreadable", unreadable) }, at)
      return next
    })
  }

  /** Ends the turn of `path`, if any, and forgets it: what it still says goes nowhere. */
  const end = (path: string): Turn | undefined => {
    const turn = turns.get(path)
    if (!turn) return undefined
    turns.delete(path)
    cancelExpiry(path)
    turn.stop()
    return turn
  }

  return {
    send,
    routine: (bot, message, cwd, run) => begin(bot, message, cwd, run ?? {}),
    undoMemory: (bot, messageId) => {
      const store = deps.memory
      const line = deps.talkOf(bot.path).messages.find((message) => message.id === messageId)
      if (!store || !line?.memoryUndo) return
      const result = undoMemoryWrite(store.get(bot.path), line.memoryUndo)
      store.set(bot.path, result.memory)
      const at = now()
      deps.update(bot.path, (talk) => {
        const messages = talk.messages.map((message) => {
          if (message.id !== messageId) return message
          const { memoryUndo: _done, ...rest } = message
          return rest
        })
        return appendMessage(
          { ...talk, messages },
          result.ok ? { role: "tool", tool: "ade", text: result.message } : { role: "error", text: result.error },
          at,
        )
      })
    },
    answer: (bot, choice) => {
      const turn = turns.get(bot.path)
      const asked = deps.talkOf(bot.path).permission
      if (!turn || !asked) return
      // Only Nega was offered: nothing else is sent, whatever reaches here.
      if (asked.denyOnly && choice !== "reject") return
      // Every danger of the command: «Sempre» on one must not let the others through (M3).
      if (choice === "always" && asked.always) for (const key of asked.always) always.add(bot.path, key)
      reply(bot.path, turn, choice === "reject" ? "reject" : "once")
    },
    grant: (bot) => {
      const offer = deps.talkOf(bot.path).offer
      if (!offer) return
      for (const key of offer.always) always.add(bot.path, key)
      deps.update(bot.path, (talk) => {
        const { offer: _done, ...rest } = talk
        return appendMessage(
          rest,
          { role: "tool", tool: "ade", text: t("bots.approval.alwaysSet", offer.reason) },
          now(),
        )
      })
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
