import { t } from "../i18n"
import type { WaitingApproval } from "./approvals"
import { visibleText } from "./visible-text"

/**
 * How ADE tells the user that a bot waits for them (the user's choice 4): the badge on the Bot section, a line in the
 * bell, and the window flashing in the taskbar when ADE is behind. The rules are here; `workbench.tsx` only draws them.
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

/**
 * What the request wants to do, in everyday words with ragu's name for it in brackets (the user's choice 6): «eseguire un
 * comando (bash)», not «usare "bash"». A permission this version has no words for is named as ragu names it.
 */
export function approvalAction(waiting: Pick<WaitingApproval, "permission" | "patterns">): string {
  const patterns = visibleText(waiting.patterns.trim()) || "?"
  if (waiting.permission === "bash") return t("bots.waiting.actionBash", patterns)
  if (waiting.permission === "external_directory") return t("bots.waiting.actionOutside", patterns)
  if (waiting.permission === "edit") return t("bots.waiting.actionEdit", patterns)
  return t("bots.waiting.actionTool", waiting.permission, patterns)
}

/** The bell's line: whose bot, and what it wants to do. */
export function approvalLine(waiting: Pick<WaitingApproval, "botName" | "permission" | "patterns">): string {
  return t("bots.waiting.notice", waiting.botName, approvalAction(waiting))
}

/** The window flashes in the taskbar only when the user is not looking at ADE: the bell and the badge are enough when they are. */
export function shouldNotifySystem(windowInFront: boolean): boolean {
  return !windowInFront
}
