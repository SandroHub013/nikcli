/**
 * Loads what a level needs: N3's people and N3's shop and plaza.
 *
 * Each can fail on its own and the city keeps its placeholders for what failed (people of boxes, shops of
 * boxes), saying why. Alta's 2K set is not in the installer, so it may simply not be there: then the level
 * is Media, which is, and the reason says so.
 */

import type { CastDeps } from "./assets"
import { loadCast } from "./assets"
import { loadKit, type CityKit } from "./kit"
import { LEVELS, type Level } from "./quality"
import type { Cast } from "./rig"

export interface LevelAssets {
  /** The level actually loaded: the one asked for, or Media when Alta's files are not there. */
  level: Level
  cast?: Cast
  kit?: CityKit
  /** Why each part is missing, and why the level is not what was asked for. */
  notes: string[]
}

const message = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 200)

async function loadAt(level: Level, deps: Omit<CastDeps, "level">) {
  const at = { ...deps, level: level.id }
  const [cast, kit] = await Promise.allSettled([loadCast(at), loadKit(at)])
  return {
    cast: cast.status === "fulfilled" ? cast.value : undefined,
    kit: kit.status === "fulfilled" ? kit.value : undefined,
    notes: [
      ...(cast.status === "rejected" ? [`personaggi: ${message(cast.reason)}`] : []),
      ...(kit.status === "rejected" ? [`negozio e piazza: ${message(kit.reason)}`] : []),
    ],
  }
}

export async function loadLevel(asked: Level, deps: Omit<CastDeps, "level">): Promise<LevelAssets> {
  const first = await loadAt(asked, deps)
  if (asked.id === "alta" && first.notes.length) {
    const second = await loadAt(LEVELS.media, deps)
    return { level: LEVELS.media, cast: second.cast, kit: second.kit, notes: [`i file di Alta non ci sono (${first.notes.join("; ")}): Media`, ...second.notes] }
  }
  return { level: asked, ...first }
}
