/**
 * What the plugin manager shows, worked out away from the component.
 *
 * Its own `.ts` for the reason `command/group-hits.ts` gives: a `.tsx` cannot
 * be imported by a test in this package, so anything with a rule in it has to
 * live where both the component and the test can reach it. What is left in
 * `manager.tsx` is JSX over these rows and nothing else.
 */
import type { RegisteredCommand, RegisteredPane, RegisteredSection } from "../registry"
import type { PluginStatus } from "../runtime"

export interface ManagerRow {
  readonly id: string
  readonly spec: string
  readonly source: PluginStatus["source"]
  readonly active: boolean
  readonly error?: string
  /** What this plugin put on each surface. Zero is shown, not hidden. */
  readonly commands: number
  readonly panes: number
  readonly sections: number
}

export interface ManagerInput {
  readonly status: readonly PluginStatus[]
  readonly commands: readonly RegisteredCommand[]
  readonly panes: readonly RegisteredPane[]
  readonly sections: readonly RegisteredSection[]
}

/**
 * One row per plugin, failures first.
 *
 * Failures first because they are the only rows that need doing something
 * about: a manager that lists twelve working plugins and buries the one that
 * threw is a list, not a report. Within each group the order is the order they
 * were loaded, which is the order the config declares — so a user comparing
 * this against their `tui.json` reads the two the same way round.
 */
export function managerRows(input: ManagerInput): ManagerRow[] {
  const count = <T extends { pluginId: string }>(list: readonly T[], id: string) =>
    list.reduce((total, item) => (item.pluginId === id ? total + 1 : total), 0)

  const rows = input.status.map((entry): ManagerRow => ({
    id: entry.id,
    spec: entry.spec,
    source: entry.source,
    active: entry.active,
    error: entry.error,
    commands: count(input.commands, entry.id),
    panes: count(input.panes, entry.id),
    sections: count(input.sections, entry.id),
  }))

  // A stable partition, not a sort: `toSorted` with a boolean comparator would
  // be stable too, but this says what is happening.
  return [...rows.filter((row) => !row.active), ...rows.filter((row) => row.active)]
}

/** The one-line summary above the list. Italian, like everything user-facing. */
export function managerSummary(rows: readonly ManagerRow[]): string {
  if (rows.length === 0) return "Nessun plugin caricato."
  const failed = rows.filter((row) => !row.active).length
  const active = rows.length - failed
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  if (failed === 0) return `${plural(active, "plugin attivo", "plugin attivi")}.`
  return `${plural(active, "plugin attivo", "plugin attivi")}, ${plural(failed, "non caricato", "non caricati")}.`
}

/** What a row contributes, as a phrase, or `undefined` when it contributes nothing. */
export function contributionLabel(row: ManagerRow): string | undefined {
  const parts: string[] = []
  if (row.commands) parts.push(`${row.commands} ${row.commands === 1 ? "comando" : "comandi"}`)
  if (row.panes) parts.push(`${row.panes} ${row.panes === 1 ? "pannello" : "pannelli"}`)
  if (row.sections) parts.push(`${row.sections} ${row.sections === 1 ? "sezione" : "sezioni"}`)
  return parts.length ? parts.join(" · ") : undefined
}
