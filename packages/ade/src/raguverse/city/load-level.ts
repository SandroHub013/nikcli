/**
 * Loads what a level needs: N3's people and N3's shop and plaza.
 *
 * Each can fail on its own and the city keeps its placeholders for what failed (people of boxes, shops of
 * boxes), saying why; a picture that cannot be decoded leaves its model with plain colours, and says so.
 * Alta's 2K set is not in the installer, so it may simply not be there: then the level is still Alta (its
 * pixel ratio and, one day, its effects) with Media's 1K pictures, and the reason says so.
 */

import type { CastDeps } from "./assets"
import { loadCast } from "./assets"
import { loadKit, type CityKit } from "./kit"
import { LEVELS, type Level } from "./quality"
import type { Cast } from "./rig"

export interface LevelAssets {
  /** The level the city runs at: the one asked for, whichever pictures it could have. */
  level: Level
  /** The level whose files were loaded: Media's for Alta when the 2K set is not there. */
  assets: Level
  cast?: Cast
  kit?: CityKit
  /** Why each part is missing or plain, and why the pictures are not the level's. */
  notes: string[]
}

const message = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 200)

async function loadAt(level: Level, deps: Omit<CastDeps, "level">) {
  // One list, kept: the people's pictures are decoded as they come near, and what fails then is added to it.
  const notes: string[] = []
  const at = { ...deps, level: level.id, warn: (text: string) => void notes.push(text) }
  const [cast, kit] = await Promise.allSettled([loadCast(at), loadKit(at)])
  notes.unshift(
    ...(cast.status === "rejected" ? [`personaggi: ${message(cast.reason)}`] : []),
    ...(kit.status === "rejected" ? [`negozio e piazza: ${message(kit.reason)}`] : []),
  )
  return {
    cast: cast.status === "fulfilled" ? cast.value : undefined,
    kit: kit.status === "fulfilled" ? kit.value : undefined,
    notes,
  }
}

export async function loadLevel(asked: Level, deps: Omit<CastDeps, "level">): Promise<LevelAssets> {
  const first = await loadAt(asked, deps)
  if (asked.id === "alta" && first.notes.length) {
    const second = await loadAt(LEVELS.media, deps)
    return {
      level: asked,
      assets: LEVELS.media,
      cast: second.cast,
      kit: second.kit,
      // The same list as Media's: what its people's pictures say later still lands in it.
      notes: (second.notes.unshift(`i file di Alta non ci sono (${first.notes.join("; ")}): texture di Media`), second.notes),
    }
  }
  return { level: asked, assets: asked, ...first }
}
