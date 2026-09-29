/** The shipped characters, loaded from disk for the tests: the same code as the world, without the pictures. */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { loadCast } from "./assets"
import type { Cast } from "./rig"

export const LEVELS_DIR = join(import.meta.dir, "..", "..", "..", "src-tauri", "nikverse-assets", "levels")

/**
 * The levels whose files are here: Bassa and Media ship, Alta's 2K set is a developer's local copy
 * (`sync-nikverse-assets --alta`), so tests over "every level" run over the ones present.
 */
export const presentLevels = (): string[] => ["bassa", "media", "alta"].filter((level) => existsSync(join(LEVELS_DIR, level, "character_user.glb")))

const loaded = new Map<string, Promise<Cast>>()

/** The cast of a level, loaded once for the whole test run. */
export function castOf(level: string): Promise<Cast> {
  let cast = loaded.get(level)
  if (!cast) {
    cast = loadCast({
      base: "file:///assets/",
      level,
      fetchBytes: async (url) => {
        const path = join(LEVELS_DIR, url.replace("file:///assets/levels/", ""))
        return (await Bun.file(path).arrayBuffer()) as ArrayBuffer
      },
    })
    loaded.set(level, cast)
  }
  return cast
}
