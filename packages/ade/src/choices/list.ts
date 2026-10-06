/**
 * Helpers for decisions and design proposals waiting for the user.
 * Plain `.ts`, tested without a DOM; the sheets only draw it.
 */
import { t } from "../i18n"

/**
 * Who asked, as the lists name the pane: its told-apart name while it is
 * open (`distinctNames`, through the candidates' titles), the title the
 * register kept otherwise. The card's «da Sessione 1 — Terminal · oggi» had no
 * (1)/(2) while the list had (Verifiche, rifiniture 1).
 */
export function askerName(
  item: { readonly raisedBy: string; readonly raisedFrom?: string },
  panes: readonly { readonly id: string; readonly title: string }[],
): string {
  return (item.raisedFrom && panes.find((pane) => pane.id === item.raisedFrom)?.title) || item.raisedBy
}

/** Whether `name` is the choice the writer recommends: the register checks it is one of them, by name. */
export function isRecommended(recommend: { readonly option: string } | undefined, name: string): boolean {
  return recommend !== undefined && recommend.option === name
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
 * Where a sheet goes once an answer given in it leaves nothing open there:
 * stay open while its own family still has entries, closed when nothing does.
 */
export function afterAnswer(openHere: number): "stay" | "close" {
  return openHere > 0 ? "stay" : "close"
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
