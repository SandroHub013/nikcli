/**
 * The words the footer shows for what ADE is spending.
 *
 * ADE only — the app, its webview, the agents in the panes and their
 * children — never the machine as a whole: the question the strip answers is
 * "how much is ADE costing me", and a machine-wide number would move with a
 * browser in another window.
 *
 * Pure, so the rounding can be tested without a Solid component.
 */

import type { SystemStats } from "../host/shell"

const GB = 1024 ** 3
const MB = 1024 ** 2

/** `812 MB` under a gigabyte, `1.4 GB` above: the unit a person would say. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB"
  if (bytes < GB) return `${Math.round(bytes / MB)} MB`
  return `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`
}

/** How loaded a number is, for the colour: calm, busy, or close to the ceiling. */
export type Load = "ok" | "busy" | "high"

export function loadOf(percent: number): Load {
  if (percent >= 90) return "high"
  if (percent >= 70) return "busy"
  return "ok"
}

export interface StatView {
  cpu: { text: string; load: Load; title: string }
  ram: { text: string; load: Load; title: string }
  mem: { text: string; load: Load; title: string }
}

export function describeStats(stats: SystemStats): StatView {
  const cpu = Math.max(0, Math.min(100, stats.cpu))
  const share = stats.ramTotal > 0 ? (stats.appMem / stats.ramTotal) * 100 : 0
  const who = `ADE e i suoi ${stats.processes} processi (webview e agenti)`
  return {
    cpu: {
      text: `${cpu < 10 ? cpu.toFixed(1) : Math.round(cpu)}%`,
      load: loadOf(cpu),
      title: `CPU usata da ${who}: ${cpu.toFixed(1)}%`,
    },
    ram: {
      text: formatBytes(stats.appMem),
      load: loadOf(share),
      title: `RAM occupata da ${who}: ${formatBytes(stats.appMem)}`,
    },
    mem: {
      text: `${share < 10 ? share.toFixed(1) : Math.round(share)}%`,
      load: loadOf(share),
      title: `Quota della memoria del computer (${formatBytes(stats.ramTotal)}) usata da ADE`,
    },
  }
}
