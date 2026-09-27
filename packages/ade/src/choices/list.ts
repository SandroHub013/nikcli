/**
 * «Da scegliere»: the decisions and the design proposals waiting for the user,
 * in one list behind one button (notifiche-design).
 *
 * There were two buttons in the bar, each opening its own window one item at
 * a time. The user asked for one: it counts both, and its list says of each
 * entry what it is, who asked and how long ago. Plain `.ts`, tested without a
 * DOM; the sheet only draws it.
 */
import { bucketDecisions, type Decision } from "../decisions/state"
import { bucketProposals, type DesignProposal } from "../design/state"
import type { QueueCounts } from "../surface/bar-queue"
import { t } from "../i18n"

export type ChoiceKind = "decision" | "design"

export interface ChoiceItem {
  readonly kind: ChoiceKind
  readonly k: string
  readonly title: string
  /** Who asked: the asking pane's title. */
  readonly by: string
  readonly openedAt: string
}

/** What waits for the user, the oldest first: it has waited longest. */
export function choiceItems(
  decisions: readonly Decision[],
  proposals: readonly DesignProposal[],
): readonly ChoiceItem[] {
  const items: ChoiceItem[] = [
    ...bucketDecisions(decisions).forYou.map((decision) => ({
      kind: "decision" as const,
      k: decision.k,
      title: decision.title,
      by: decision.raisedBy,
      openedAt: decision.openedAt,
    })),
    ...bucketProposals(proposals).forYou.map((proposal) => ({
      kind: "design" as const,
      k: proposal.k,
      title: proposal.title,
      by: proposal.raisedBy,
      openedAt: proposal.openedAt,
    })),
  ]
  return items.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt))
}

/** The button's counts: the two registers' added up. */
export function choiceCounts(decisions: QueueCounts, design: QueueCounts): QueueCounts {
  return {
    waiting: decisions.waiting + design.waiting,
    queued: decisions.queued + design.queued,
    discarded: decisions.discarded + design.discarded,
  }
}

/** «12 min fa», «3 h fa», «2 giorni fa»: how long an entry has waited. */
export function waitedFor(openedAt: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(openedAt)) / 60_000))
  if (!Number.isFinite(minutes) || minutes < 1) return t("choices.age.now")
  if (minutes < 60) return t("choices.age.minutes", minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t("choices.age.hours", hours)
  return t("choices.age.days", Math.floor(hours / 24))
}
