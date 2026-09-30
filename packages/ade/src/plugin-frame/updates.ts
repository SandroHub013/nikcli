/**
 * The check for new plugin versions, run with ADE's own: each installed plugin is asked about, and a version on offer is downloaded in the
 * background into `pending`. Nothing is switched on here: the panel does that the next time it opens (`activation.ts`), so an update never
 * changes a plugin that is running. A version that was taken back once is not downloaded again.
 */

import type { InstalledPlugin, PluginAvailable } from "./host-types"

export type Available = PluginAvailable

export interface UpdateIo {
  list: () => Promise<InstalledPlugin[]>
  check: (id: string) => Promise<Available>
  /** Downloads into `pending`; resolves `false` when there was nothing to download. */
  install: (id: string) => Promise<boolean>
  rejected: (id: string, version: string) => boolean
}

/** How long the plugins wait between two looks at their index: it is a download, and an update is not urgent. */
export const PLUGIN_CHECK_EVERY_MS = 6 * 60 * 60_000

/** Whether it is time to ask the index again; `force` is a person pressing «Controlla aggiornamenti». A clock that went back does not block it. */
export function shouldCheck(lastAt: number | undefined, now: number, force = false): boolean {
  if (force || lastAt === undefined || !Number.isFinite(lastAt)) return true
  return now < lastAt || now - lastAt >= PLUGIN_CHECK_EVERY_MS
}

export interface UpdateResult {
  id: string
  version?: string
  outcome: "downloaded" | "up-to-date" | "rejected" | "failed"
  reason?: string
}

/** One plugin after the other: a check is a download of an index, and there is no hurry. Never throws. */
export async function checkForUpdates(io: UpdateIo): Promise<UpdateResult[]> {
  const results: UpdateResult[] = []
  let installed: InstalledPlugin[]
  try {
    installed = await io.list()
  } catch (error) {
    return [{ id: "*", outcome: "failed", reason: describe(error) }]
  }
  for (const plugin of installed) {
    // A plugin served from a folder is not on any index.
    if (plugin.dev) continue
    try {
      const offered = await io.check(plugin.id)
      if (!offered.update) {
        results.push({ id: plugin.id, version: offered.version, outcome: "up-to-date" })
        continue
      }
      if (io.rejected(plugin.id, offered.version)) {
        results.push({ id: plugin.id, version: offered.version, outcome: "rejected" })
        continue
      }
      const downloaded = await io.install(plugin.id)
      results.push({ id: plugin.id, version: offered.version, outcome: downloaded ? "downloaded" : "up-to-date" })
    } catch (error) {
      results.push({ id: plugin.id, outcome: "failed", reason: describe(error) })
    }
  }
  return results
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}
