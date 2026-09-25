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
 */

import { t } from "../../i18n"
import { answerKeys, emptyTalk, noticePermission, permissionAnswered, type PendingPermission, type PermissionAnswer } from "../talk"
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
): Promise<{ answer: PermissionAnswer; expired: boolean }> {
  const value = await ask(
    t("gateway.approve.question", permission.permission, shownCommand(permission.patterns)),
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
}): (chunk: string) => void {
  let talk = emptyTalk()
  let asking = false
  const refused = new Set<string>()
  return (chunk) => {
    if (asking || deps.signal.aborted) return
    talk = noticePermission(talk, chunk, Date.now())
    const pending = talk.permission
    if (!pending) return
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
    void approveOnPhone(pending, deps.ask, deps.signal).then(({ answer, expired }) => {
      if (!deps.signal.aborted) deps.write(answerKeys(answer))
      if (expired) deps.say(t("gateway.approve.expired"))
      talk = permissionAnswered(talk, Date.now())
      asking = false
    })
  }
}
