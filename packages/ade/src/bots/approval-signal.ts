import { t } from "../i18n"
import type { WaitingApproval } from "./approvals"

/**
 * How ADE tells the user that a bot waits for them (the user's choice 4): the badge on the Bot section, a line in the
 * bell, and a system notification when ADE is behind. The rules are here; `workbench.tsx` only draws them.
 */

/** The requests in `waiting` that were not in `seen`, and the new `seen`: the ones still open, so a question asked again later is news again. */
export function freshApprovals(
  seen: ReadonlySet<string>,
  waiting: readonly WaitingApproval[],
): { readonly fresh: WaitingApproval[]; readonly seen: Set<string> } {
  return {
    fresh: waiting.filter((one) => !seen.has(one.id)),
    seen: new Set(waiting.map((one) => one.id)),
  }
}

/** What the badge on the Bot section shows. Nothing, not a zero, when nothing waits. */
export function approvalBadge(waiting: readonly WaitingApproval[]): { readonly badge: number | undefined; readonly attention: boolean } {
  return { badge: waiting.length > 0 ? waiting.length : undefined, attention: waiting.length > 0 }
}

/** The place a request came from, in words: ADE, or the chat's app. */
export function sourcesText(sources: readonly string[]): string {
  return sources
    .map((source) => {
      if (source === "ade") return t("bots.waiting.fromAde")
      if (source === "telegram") return t("gateway.panel.platformTelegram")
      if (source === "discord") return t("gateway.panel.platformDiscord")
      if (source === "slack") return t("gateway.panel.platformSlack")
      return source
    })
    .join(" · ")
}

/** The bell's line, and the system notification's body: whose bot, and what it wants to do. */
export function approvalLine(waiting: Pick<WaitingApproval, "botName" | "permission" | "patterns">): string {
  return t("bots.waiting.notice", waiting.botName, waiting.permission, waiting.patterns.trim() || "?")
}

/** The system notification: the title says where it comes from, the body what it wants. */
export function systemNotification(waiting: WaitingApproval): { readonly title: string; readonly body: string } {
  return { title: t("bots.waiting.systemTitle", waiting.botName), body: approvalLine(waiting) }
}

/** A system notification only when the user is not looking at ADE: the bell and the badge are enough when they are. */
export function shouldNotifySystem(windowInFront: boolean): boolean {
  return !windowInFront
}
