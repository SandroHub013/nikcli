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
  appendMessage,
  applyExit,
  applyProblem,
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
   * and read-only (the `read-only` rules on ADE's server for nikcli, B8d; no
   * Bash, Edit or Write for Claude Code; Codex read-only).
   * Undefined when the bot already has a turn.
   */
  routine: (bot: AgentFile, message: string, cwd?: string, run?: RoutineRun) => Turn | undefined
  /**
   * A member's turn in a room (B8b): its own session there, in `thread`
   * rather than in the bot's chat; the user is watching the room, so nikcli's
   * questions are answered as in the panel (B8c) and shown in the room; what
   * the bot writes to its memory is only proposed. Undefined when the bot
   * already has a turn: one at a time per bot, in a room or not.
   */
  room: (bot: AgentFile, message: string, thread: string, cwd?: string, maxCostUsd?: number) => Turn | undefined
  /** The thread of `bot`'s turn under way: its own, or its place in a room. */
  threadOf: (path: string) => string
  /**
   * The user's answer to the question on screen, `requestID` (B8d): Consenti
   * (`once`), Nega (`reject`), or Sempre (`always`), which is ADE's for this
   * bot and goes to nikcli as a once: nikcli's own «always» is the project's,
   * every bot's. Nothing happens when the question on screen is another.
   */
  answer: (bot: AgentFile, choice: PermissionAnswer, requestID: string | undefined) => void
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
  /** The thread each running turn writes to, when it is not the bot's own (a room, B8b). */
  const threads = new Map<string, string>()
  const threadOf = (path: string) => threads.get(path) ?? path
  /** The Nega waiting on each bot's open question. */
  const expiries = new Map<string, () => void>()
  const cancelExpiry = (path: string) => {
    expiries.get(path)?.()
    expiries.delete(path)
  }

  /** Answers nikcli's question `asked` and closes it; a line in the thread when there is something to say. */
  const reply = (path: string, turn: Turn, asked: PendingPermission, answer: "once" | "reject", line?: string) => {
    cancelExpiry(path)
    // On ADE's server the question has an id (B8d): the answer goes to it, and to no other (review, M1).
    if (asked.requestID !== undefined) turn.answer?.(asked.requestID, answer)
    const at = now()
    deps.update(threadOf(path), (talk) => {
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
    const verdict = decide(asked.permission, asked.patterns, always.get(path))
    if (verdict.kind === "block")
      return reply(path, turn, asked, "reject", t("bots.approval.blocked", asked.patterns, t(verdict.rule.reason)))
    if (verdict.kind === "allow") return reply(path, turn, asked, "once")
    const expiresAt = asked.askedAt + APPROVAL_TIMEOUT_MS
    deps.update(threadOf(path), (talk) =>
      talk.permission === asked
        ? {
            ...talk,
            permission: {
              ...asked,
              reason: verdict.reason,
              ...(verdict.keys ? { always: verdict.keys } : {}),
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
        const still = deps.talkOf(threadOf(path)).permission
        if (turns.get(path) !== turn || still?.askedAt !== asked.askedAt) return
        reply(path, turn, asked, "reject", t("bots.approval.expired", asked.patterns))
      }, APPROVAL_TIMEOUT_MS),
    )
  }

  const begin = (
    bot: AgentFile,
    message: string,
    cwd: string | undefined,
    routine: RoutineRun | undefined,
    room?: { readonly thread: string; readonly maxCostUsd?: number },
  ): Turn | undefined => {
    const path = bot.path
    if (turns.has(path)) return undefined
    /* The thread the turn writes to: the bot's own, or its place in a room (B8b). */
    const thread = room?.thread ?? path
    const runner = runnerById(bot.runner)
    const account = deps.accountOf?.(path) ?? { mode: "plan" as const }
    deps.update(thread, (talk) => {
      // An offer from the last turn is not for this one.
      const { offer: _stale, ...rest } = talk
      const marked = routine ? appendMessage(rest, { role: "tool", tool: "ade", text: t("bots.routine.thread") }, Date.now()) : rest
      return { ...sendMessage(marked, message, Date.now()), turnMode: spendKind(runner.id, bot.model, account) }
    })
    const sessionId = deps.talkOf(thread).sessionId
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
    const from = deps.talkOf(thread).messages.length
    const current = () => turns.get(path) === turn
    /*
     * A question on the thread, then settled. Nobody is there to answer a
     * routine (B11 review, BASSO 1): whatever nikcli asks is refused at once,
     * not left waiting until the turn runs out of time.
     */
    const ask = (asked: PendingPermission) => {
      if (routine) return reply(path, turn, asked, "reject", t("bots.routine.refused", asked.permission, asked.patterns))
      settle(bot, turn, asked)
    }
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
      ...((routine ?? room)?.maxCostUsd !== undefined ? { maxCostUsd: (routine ?? room)!.maxCostUsd! } : {}),
      timeoutMs: BOT_TURN_TIMEOUT_MS,
      // Someone is watching the panel and a room: a project not admitted yet is asked about (B8d).
      interactive: !routine,
      /* nikcli on ADE's server (B8d): its events as changes to the thread, and its questions by id, one at a time. */
      onChange: (change) => {
        if (current()) deps.update(thread, change)
      },
      onPermission: (question) => {
        if (!current()) return
        const asked: PendingPermission = { ...question, askedAt: now() }
        deps.update(thread, (talk) => ({ ...talk, status: "waiting", permission: asked, updatedAt: asked.askedAt }))
        ask(asked)
      },
      onLine: (line) => {
        if (current()) deps.update(thread, (talk) => applyRunnerLine(runner, talk, line, Date.now()))
      },
    }
    const turn = routine && deps.runRoutine ? deps.runRoutine(request, routine) : deps.runTurn(request)
    turns.set(path, turn)
    if (thread !== path) threads.set(path, thread)
    void turn.result.then((result) => {
      if (!current()) return
      settleMemory(path, thread, from, routine ? "routine" : room ? "room" : "panel")
      turns.delete(path)
      threads.delete(path)
      cancelExpiry(path)
      const at = Date.now()
      deps.update(thread, (talk) => {
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
  const settleMemory = (path: string, thread: string, from: number, source: "panel" | "routine" | "room") => {
    const store = deps.memory
    if (!store) return
    const said = deps
      .talkOf(thread)
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
     * waits for the user's click in the Memoria section (B8a review). So does
     * every write of a routine, nobody was there to see it, and of a room,
     * where the user is not in front of every turn (B8b).
     */
    const { memory, lines } = settleMemoryOps(store.get(path), ops, () => crypto.randomUUID(), {
      propose: (op) => source !== "panel" || op.block === "user",
      from: source,
      at: now(),
    })
    // The bot hears of what failed, and of what waits for the user.
    const failures = lines.flatMap((line) => (!line.ok || line.proposal ? [line.text] : []))
    if (unreadable > 0) failures.push(t("bots.memory.error.unreadable", unreadable))
    store.set(path, { ...memory, ...(failures.length > 0 ? { pending: failures } : {}) })
    const at = now()
    deps.update(thread, (talk) => {
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
    threads.delete(path)
    cancelExpiry(path)
    turn.stop()
    return turn
  }

  return {
    send,
    routine: (bot, message, cwd, run) => begin(bot, message, cwd, run ?? {}),
    room: (bot, message, thread, cwd, maxCostUsd) =>
      begin(bot, message, cwd, undefined, { thread, ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) }),
    threadOf,
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
    answer: (bot, choice, requestID) => {
      const turn = turns.get(bot.path)
      const asked = deps.talkOf(threadOf(bot.path)).permission
      if (!turn || !asked) return
      // The card the user clicked, not whatever question took its place meanwhile (review, M1).
      if (asked.requestID !== requestID) return
      // Every danger of the command: «Sempre» on one must not let the others through (M3).
      if (choice === "always" && asked.always) for (const key of asked.always) always.add(bot.path, key)
      // A Nega is said in the thread, as a block or an expiry is: the bot's next words come after a refusal.
      if (choice === "reject") reply(bot.path, turn, asked, "reject", t("bots.approval.denied", asked.patterns))
      else reply(bot.path, turn, asked, "once")
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
      const thread = threadOf(bot.path)
      if (!end(bot.path)) return
      deps.update(thread, (talk) => applyExit(talk, null, Date.now(), runnerById(bot.runner).label))
    },
    forget: (bot) => {
      end(bot.path)
      deps.update(bot.path, () => emptyTalk())
    },
    running: (path) => turns.has(path),
  }
}
