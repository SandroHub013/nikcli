/**
 * Writes the brand (`brand.json`) into the two Tauri configs, or checks them.
 *
 *   bun script/brand.ts          # apply   (also `bun run brand`)
 *   bun script/brand.ts --check  # exit 1 if a config disagrees with brand.json
 *
 * The rules live in src/brand.ts, where the unit test can reach them.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { asBrand, derived, drift, set, type Json } from "../src/brand"

const ROOT = join(import.meta.dir, "..")
export const CONFIGS = {
  main: join(ROOT, "src-tauri", "tauri.conf.json"),
  test: join(ROOT, "src-tauri", "tauri.test.conf.json"),
} as const

const brand = asBrand(JSON.parse(readFileSync(join(ROOT, "brand.json"), "utf8")))
const wanted = derived(brand)

if (process.argv.includes("--check")) {
  const problems: string[] = []
  for (const which of Object.keys(CONFIGS) as (keyof typeof CONFIGS)[]) {
    const config = JSON.parse(readFileSync(CONFIGS[which], "utf8")) as Json
    for (const line of drift(config, wanted[which])) problems.push(`${CONFIGS[which]}: ${line}`)
  }
  if (problems.length > 0) {
    console.error("The Tauri configs disagree with brand.json; run `bun run brand`:")
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log("configs match brand.json")
} else {
  for (const which of Object.keys(CONFIGS) as (keyof typeof CONFIGS)[]) {
    const config = JSON.parse(readFileSync(CONFIGS[which], "utf8")) as Json
    for (const [path, value] of Object.entries(wanted[which])) set(config, path, value)
    writeFileSync(CONFIGS[which], `${JSON.stringify(config, null, 2)}\n`)
    console.log(`${CONFIGS[which]}: ${Object.keys(wanted[which]).length} fields from brand.json`)
  }
}
