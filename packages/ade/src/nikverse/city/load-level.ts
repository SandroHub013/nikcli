/**
 * Loads what a level needs: N3's people. The shops and the plaza are code, not files.
 *
 * If the people fail the city keeps its boxes, saying why. Alta's 2K set is not in the installer, so it may
 * simply not be there: then the level is Media, which is, and the reason says so.
 */

import type { CastDeps } from "./assets"
import { loadCast } from "./assets"
import { LEVELS, type Level } from "./quality"
import type { Cast } from "./rig"

export interface LevelAssets {
  /** The level actually loaded: the one asked for, or Media when Alta's files are not there. */
  level: Level
  cast?: Cast
  /** Why the people are missing, and why the level is not what was asked for. */
  notes: string[]
}

const message = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 200)

async function loadAt(level: Level, deps: Omit<CastDeps, "level">) {
  const at = { ...deps, level: level.id }
  const [cast] = await Promise.allSettled([loadCast(at)])
  return {
    cast: cast.status === "fulfilled" ? cast.value : undefined,
    notes: cast.status === "rejected" ? [`personaggi: ${message(cast.reason)}`] : [],
  }
}

export async function loadLevel(asked: Level, deps: Omit<CastDeps, "level">): Promise<LevelAssets> {
  const first = await loadAt(asked, deps)
  if (asked.id === "alta" && first.notes.length) {
    const second = await loadAt(LEVELS.media, deps)
    return { level: LEVELS.media, cast: second.cast, notes: [`i file di Alta non ci sono (${first.notes.join("; ")}): Media`, ...second.notes] }
  }
  return { level: asked, ...first }
}
