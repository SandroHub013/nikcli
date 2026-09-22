/**
 * Writes the brand (`brand.json`) into the two Tauri configs, or checks them.
 *
 *   bun script/brand.ts          # apply   (also `bun run brand`)
 *   bun script/brand.ts --check  # exit 1 if a config disagrees with brand.json
 *
 * The rules live in src/brand.ts, where the unit test can reach them.
 */
import { applyBrand, checkConfigs } from "../src/brand"

if (process.argv.includes("--check")) {
  const problems = checkConfigs()
  if (problems.length > 0) {
    console.error("The Tauri configs disagree with brand.json; run `bun run brand`:")
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log("configs match brand.json")
} else {
  applyBrand()
}
