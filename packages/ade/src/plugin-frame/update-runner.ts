/**
 * The check for plugin updates as ADE runs it: on the schedule of its own update check, at most every six hours, and only when a plugin is
 * installed (`marker.ts`). Loaded by a dynamic import, so ADE without plugins never pays for it.
 */

import type { Host } from "../host/shell"
import { pluginsChanged } from "./changes"
import { createRejectedBook } from "./grants"
import { markFramePlugins } from "./marker"
import { checkForUpdates, shouldCheck } from "./updates"

const LAST_KEY = "ade.plugin-update-at"

function lastRun(): number | undefined {
  try {
    const raw = localStorage.getItem(LAST_KEY)
    return raw ? Number(raw) : undefined
  } catch {
    return undefined
  }
}

export async function runPluginUpdates(getHost: () => Promise<Host | undefined>, options: { force?: boolean } = {}): Promise<void> {
  const now = Date.now()
  if (!shouldCheck(lastRun(), now, options.force)) return
  const host = await getHost()
  if (!host?.pluginList || !host.pluginCheck || !host.pluginInstall) return
  const installed = await host.pluginList().catch(() => [])
  markFramePlugins(installed.length > 0)
  if (installed.length === 0) return
  try {
    localStorage.setItem(LAST_KEY, String(now))
  } catch {
    // Without storage it asks each time, which the schedule of the update check already spaces.
  }
  const rejected = createRejectedBook(localStorage)
  const results = await checkForUpdates({
    list: async () => installed,
    check: (id) => host.pluginCheck!(id),
    install: (id) => host.pluginInstall!(id),
    rejected: (id, version) => rejected.has(id, version),
  })
  if (results.some((result) => result.outcome === "downloaded")) pluginsChanged()
}
