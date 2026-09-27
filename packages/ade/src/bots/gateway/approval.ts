/**
 * nikcli's questions, asked on the phone (G5, D93).
 *
 * In a turn from a chat nobody sits at the computer, so when nikcli asks for
 * a permission the question goes to the chat, with two buttons: yes this
 * once, or no. «Always» is not offered: a standing grant from a phone is
 * exactly what the default-off shell is meant to prevent. No answer in five
 * minutes is a no, and so is a turn that ended meanwhile. Who may press is
 * decided where the press is taken (`controller.ts`): a button ADE sent, in
 * that chat, once, from an authorized sender.
 *
 * The question is nikcli's own event on ADE's server (B8d), with its id and
 * the whole command: nothing is read off a terminal, so nothing the model
 * writes can pass for one, and the command is never cut. Rust takes known
 * secrets out of everything sent to a chat.
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
import type { PendingPermission } from "../talk"
import type { Choice } from "./controller"

/** Puts a question with buttons in the chat; `undefined` when nothing valid was pressed in time. */
export type Ask = (question: string, choices: readonly Choice[], signal: AbortSignal) => Promise<string | undefined>

/** The command as the phone shows it: whole, as nikcli asked about it. */
function shown(patterns: string): string {
  return patterns.trim() || "?"
}

/** The phone's answer to one question. */
export async function approveOnPhone(
  permission: PendingPermission,
  ask: Ask,
  signal: AbortSignal,
  danger?: string,
): Promise<{ answer: "once" | "reject"; expired: boolean }> {
  const question = t("gateway.approve.question", permission.permission, shown(permission.patterns))
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
 * Answers a nikcli turn's questions from a chat, as they come
 * (`TurnRequest.onPermission`, one at a time). Every turn from a chat on
 * nikcli has one: with the remote commands on the question goes to the
 * phone; off, it is answered no at once and the chat is told what was
 * refused, instead of the turn waiting on a question nobody sees until it
 * times out (G5 review, M2).
 */
export function permissionAnswerer(deps: {
  readonly ask: Ask
  /** Answer no at once, without asking: the bot's remote commands are off. */
  readonly refuse: boolean
  /** The answer to the question with that id (`Turn.answer`): never to another that took its place. */
  readonly answer: (requestID: string | undefined, reply: "once" | "reject") => void
  /** A line for the chat, when a question went unanswered. */
  readonly say: (text: string) => void
  /** Aborted when the turn ends: a question still waiting gets no answer. */
  readonly signal: AbortSignal
}): (pending: PendingPermission) => void {
  const refused = new Set<string>()
  return (pending) => {
    if (deps.signal.aborted) return
    const command = shown(pending.patterns)
    // No «Sempre» from a chat: every command is asked, the block list refused.
    const verdict = decide(pending.permission, pending.patterns, [])
    if (verdict.kind === "block") {
      deps.answer(pending.requestID, "reject")
      deps.say(t("gateway.approve.blocked", command, t(verdict.rule.reason)))
      return
    }
    if (deps.refuse) {
      deps.answer(pending.requestID, "reject")
      // Said once per permission: a bot that keeps trying does not flood the chat.
      if (!refused.has(pending.permission)) {
        refused.add(pending.permission)
        deps.say(t("gateway.approve.refused", pending.permission, command))
      }
      return
    }
    const danger =
      verdict.kind === "ask" && (verdict.keys ?? []).every((key) => !key.startsWith("tool:"))
        ? verdict.reason
        : undefined
    void approveOnPhone(pending, deps.ask, deps.signal, danger).then(({ answer, expired }) => {
      if (!deps.signal.aborted) deps.answer(pending.requestID, answer)
      if (expired) deps.say(t("gateway.approve.expired"))
    })
  }
}
