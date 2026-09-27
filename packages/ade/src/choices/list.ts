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
  /** The open panes' names (`distinctNames`): who asked, told apart from a pane of the same title. */
  names?: ReadonlyMap<string, string>,
): readonly ChoiceItem[] {
  const asker = (item: { raisedBy: string; raisedFrom?: string }) =>
    (item.raisedFrom && names?.get(item.raisedFrom)) || item.raisedBy
  const items: ChoiceItem[] = [
    ...bucketDecisions(decisions).forYou.map((decision) => ({
      kind: "decision" as const,
      k: decision.k,
      title: decision.title,
      by: asker(decision),
      openedAt: decision.openedAt,
    })),
    ...bucketProposals(proposals).forYou.map((proposal) => ({
      kind: "design" as const,
      k: proposal.k,
      title: proposal.title,
      by: asker(proposal),
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

/**
 * Where a sheet goes once an answer given in it leaves nothing open there
 * (Verifiche, da-scegliere, problem 3): it stayed open on «Nessuna proposta
 * di design aperta». Back to «Da scegliere» while something else waits, closed
 * when nothing does; open while its own family still has entries.
 */
export function afterAnswer(openHere: number, waiting: number): "stay" | "list" | "close" {
  if (openHere > 0) return "stay"
  return waiting > 0 ? "list" : "close"
}

/**
 * Each pane's name as the lists show it: a title that two panes share gets
 * its place among them, «Sessione 1 — Terminal (2)» (Verifiche, da-scegliere,
 * problem 4). Two terminals opened one after the other had the same title, and
 * «chiesta da» and «→» could not say which one; the delivery goes by id.
 */
export function distinctNames(panes: readonly { readonly id: string; readonly title: string }[]): Map<string, string> {
  const total = new Map<string, number>()
  for (const pane of panes) total.set(pane.title, (total.get(pane.title) ?? 0) + 1)
  const seen = new Map<string, number>()
  const names = new Map<string, string>()
  for (const pane of panes) {
    const place = (seen.get(pane.title) ?? 0) + 1
    seen.set(pane.title, place)
    names.set(pane.id, (total.get(pane.title) ?? 0) > 1 ? t("choices.samePane", pane.title, place) : pane.title)
  }
  return names
}
