import { t } from "../i18n"
import { DANGEROUS } from "./approval"

/**
 * A bot's «Sempre» (`approval.ts`), in words, for the Permissions tab (the user's choice 4): each key is a kind of
 * danger the bot may go ahead with, a folder outside the project, or a tool ragu asks about. The kept keys are the
 * ones `decide` reads, so what the list shows is what really holds.
 */
export function alwaysText(key: string): string {
  const rule = DANGEROUS.find((one) => one.id === key)
  if (rule) {
    const reason = t(rule.reason)
    return reason.charAt(0).toUpperCase() + reason.slice(1)
  }
  if (key.startsWith("outside:")) return t("bots.permissions.alwaysOutside", key.slice("outside:".length))
  if (key.startsWith("tool:")) return t("bots.permissions.alwaysTool", key.slice("tool:".length))
  // A key this version does not know (a newer one wrote it): shown as it is, and it can still be taken back.
  return key
}

/** Whether the program asks at all, so that a «Sempre» means something: ragu asks, Claude Code is refused what it does not cover, Codex never asks. */
export function alwaysApplies(runner: string): boolean {
  return runner === "ragu" || runner === "claude"
}
