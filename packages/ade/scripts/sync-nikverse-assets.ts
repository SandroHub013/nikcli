/**
 * Copies N3's finished assets into the folder the `nikverse` scheme serves.
 *
 * The generator lives outside the repo (`ade-team/nikverse-assets`, Blender and a KTX2 encoder), so what the
 * app needs is copied here and committed: for each quality level the characters' `.glb` (mesh, skeleton and
 * anchors, the texture inside), the city's `.glb` (the shop, the plaza, the lamps) and its two lightmaps;
 * once for all levels the animations (`rig_animations.glb`, the same bytes at every level, which this
 * checks), and the generator's budget. `build.rs` hashes whatever is in the folder into
 * the manifest and the tests read the budget back from here, so they run without the
 * generator.
 *
 * Alta's 2K set is not in the installer (the plan's fourth decision: it is downloaded on its own, 14 MB), so
 * it is copied only with `--alta`, into a folder `.gitignore` leaves out. Left out on purpose: the KTX2
 * textures, which no file refers to yet (the `.glb` carry PNG). `--check` copies nothing and lists what
 * would change.
 *
 *   bun scripts/sync-nikverse-assets.ts [--from DIR] [--alta] [--check]
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const from = arg("--from") ?? "C:/Users/39349/Favorites/ade-team/nikverse-assets"
const check = process.argv.includes("--check")
const withAlta = process.argv.includes("--alta")
const to = join(import.meta.dir, "..", "src-tauri", "nikverse-assets", "levels")

const config = JSON.parse(readFileSync(join(from, "config.json"), "utf8"))
const cast: string[] = [config.cast.user && "user", ...config.cast.agents.map((name: string) => `agent_${name.toLowerCase()}`)].filter(Boolean)
const levels = Object.keys(config.levels).filter((level) => level !== "alta" || withAlta)

const changes: string[] = []
const put = (source: string, target: string) => {
  if (!existsSync(source)) throw new Error(`missing in the generator's output: ${source}`)
  const bytes = readFileSync(source)
  const same = existsSync(target) && readFileSync(target).equals(bytes)
  if (same) return
  changes.push(target)
  if (check) return
  mkdirSync(join(target, ".."), { recursive: true })
  copyFileSync(source, target)
}

for (const level of levels) {
  const out = join(from, "out", level)
  for (const name of cast) put(join(out, `character_${name}.glb`), join(to, level, `character_${name}.glb`))
  put(join(out, "city.glb"), join(to, level, "city.glb"))
  const size = config.levels[level].lightmap
  for (const map of ["plaza_ground", "shop_floor"]) put(join(out, "lightmap", `${map}_${size}.png`), join(to, level, "lightmap", `${map}_${size}.png`))
}

// The animations are one file for everybody: the skeleton is the same at every level, and so must the file be.
const sets = Object.keys(config.levels).map((level) => join(from, "out", level, "rig_animations.glb"))
const first = readFileSync(sets[0])
for (const other of sets) if (!readFileSync(other).equals(first)) throw new Error(`rig_animations.glb differs between levels: ${other}`)
put(sets[0], join(to, "rig_animations.glb"))

// The generator's ceilings and each level's settings, as the tests check the assets against them.
const budget = JSON.stringify({ schema: config.schema, levels: config.levels, budget: config.budget, cast: config.cast }, null, 2) + "\n"
const budgetFile = join(to, "budget.json")
if (!existsSync(budgetFile) || readFileSync(budgetFile, "utf8") !== budget) {
  changes.push(budgetFile)
  if (!check) {
    mkdirSync(to, { recursive: true })
    writeFileSync(budgetFile, budget)
  }
}

console.log(changes.length ? `${check ? "would change" : "changed"}: ${changes.length} files\n${changes.map((c) => "  " + c).join("\n")}` : "nothing to change")
