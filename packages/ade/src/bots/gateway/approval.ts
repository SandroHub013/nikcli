/**
 * nikcli's permission menu, asked on the phone (G5, D93).
 *
 * In a turn from a chat nobody sits at the computer, so when nikcli stops on
 * «Permission required» the question goes to the chat, with two buttons:
 * yes this once, or no. «Always» is not offered: a standing grant from a
 * phone is exactly what the default-off shell is meant to prevent. No answer
 * in five minutes is a no, and so is a turn that ended meanwhile. Who may
 * press is decided where the press is taken (`controller.ts`): a button ADE
 * sent, in that chat, once, from an authorized sender.
 *
 * The command shown is as nikcli drew it in the terminal, so it can be cut:
 * the question says so, and a command surely cut is marked (`shownCommand`).
 * Rust takes known secrets out of everything sent to a chat.
 *
 * B8c: the block list comes first, here too. A blocked command is refused
 * before any question, and the chat is told why; nothing pressed on the
 * phone can let it through. A dangerous one is asked with its reason. The
 * consent for a chat's turn is given on the phone, not in ADE: whoever wrote
 * from the chat is there to answer, while ADE may have nobody in front of it
 * — a question waiting on the computer would only run out its five minutes.
 * And the bot's «Sempre», given in ADE, does not reach a chat's turn: from
 * the phone every command is asked, as D93 wants.
 */

import { t } from "../../i18n"
import { decide } from "../approval"
import {
  answerKeys,
  emptyTalk,
  noticePermission,
  permissionAnswered,
  permissionMenuReader,
  type PendingPermission,
  type PermissionAnswer,
} from "../talk"
import type { Choice } from "./controller"

/** Puts a question with buttons in the chat; `undefined` when nothing valid was pressed in time. */
export type Ask = (question: string, choices: readonly Choice[], signal: AbortSignal) => Promise<string | undefined>

/**
 * The command as the phone shows it. nikcli's menu line ends the command at
 * the first `)`, so one with an opening `(` left without its `)` was cut
 * there, `$(…)` included: marked with `…` (G5 review, BASSO 2).
 */
export function shownCommand(patterns: string): string {
  const command = patterns.trim()
  if (!command) return "?"
  const opened = command.split("(").length - 1
  const closed = command.split(")").length - 1
  return opened > closed ? `${command} …` : command
}

/** The phone's answer to one pending permission, as nikcli's menu takes it. */
export async function approveOnPhone(
  permission: PendingPermission,
  ask: Ask,
  signal: AbortSignal,
  danger?: string,
): Promise<{ answer: PermissionAnswer; expired: boolean }> {
  const question = t("gateway.approve.question", permission.permission, shownCommand(permission.patterns))
  const value = await ask(
    danger ? `${question}\n${t("gateway.approve.danger", danger)}` : question,
    [
      { label: t("gateway.approve.once"), value: "once" },
      { label: t("gateway.approve.no"), value: "reject" },
    ],
    signal,
  )
  return { answer: value === "once" ? "once" : "reject", expired: value === undefined && !signal.aborted }
}

/**
 * Watches a nikcli turn's raw output for its permission menu and answers it,
 * one question at a time. The returned function takes the output as it comes
 * (`TurnRequest.onData`). Every turn from a chat on nikcli has one: with the
 * remote commands on the question goes to the phone; off, it is answered no
 * at once and the chat is told what was refused, instead of the turn waiting
 * on a menu nobody sees until it times out (G5 review, M2).
 */
export function permissionWatcher(deps: {
  readonly ask: Ask
  /** Answer no at once, without asking: the bot's remote commands are off. */
  readonly refuse: boolean
  /** Keystrokes to the turn's CLI. */
  readonly write: (keys: string) => void
  /** A line for the chat, when a question went unanswered. */
  readonly say: (text: string) => void
  /** Aborted when the turn ends: a question still waiting gets no answer. */
  readonly signal: AbortSignal
  /** How long the output stays quiet before a menu is taken (`MENU_QUIET_MS`); for tests. */
  readonly quietMs?: number
}): (chunk: string) => void {
  let talk = emptyTalk()
  let asking = false
  const refused = new Set<string>()
  // The menu read whole, never from a line the model wrote (B8c review, M1).
  return permissionMenuReader({
    ...(deps.quietMs !== undefined ? { quietMs: deps.quietMs } : {}),
    onMenu: (seen) => {
      if (asking || deps.signal.aborted) return
      talk = noticePermission(talk, seen, Date.now())
      const pending = talk.permission
      if (!pending) return
      // No «Sempre» from a chat: every command is asked, the block list refused.
      const verdict = decide(pending.permission, pending.patterns, [], pending.cut === true)
      if (verdict.kind === "block") {
        deps.write(answerKeys("reject"))
        deps.say(t("gateway.approve.blocked", shownCommand(pending.patterns), t(verdict.rule.reason)))
        talk = permissionAnswered(talk, Date.now())
        return
      }
      if (deps.refuse) {
        deps.write(answerKeys("reject"))
        // Said once per permission: a bot that keeps trying does not flood the chat.
        if (!refused.has(pending.permission)) {
          refused.add(pending.permission)
          deps.say(t("gateway.approve.refused", pending.permission, shownCommand(pending.patterns)))
        }
        talk = permissionAnswered(talk, Date.now())
        return
      }
      asking = true
      const danger =
        verdict.kind === "ask" && verdict.keys?.some((key) => !key.startsWith("tool:")) ? verdict.reason : undefined
      void approveOnPhone(pending, deps.ask, deps.signal, danger).then(({ answer, expired }) => {
        if (!deps.signal.aborted) deps.write(answerKeys(answer))
        if (expired) deps.say(t("gateway.approve.expired"))
        talk = permissionAnswered(talk, Date.now())
        asking = false
      })
    },
  })
}
