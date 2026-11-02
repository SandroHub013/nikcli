/**
 * Writes the ragù palette block into the Raguverse frames' stylesheets, from `src/index.css`
 * (`src/raguverse/ragu-tokens.ts` says why). `--check` writes nothing and exits 1 if a sheet is out of date.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { raguTokensBlock, withBlock } from "../src/raguverse/ragu-tokens"

const root = join(import.meta.dir, "..", "src")
const index = readFileSync(join(root, "index.css"), "utf8")
const block = raguTokensBlock(index)
const check = process.argv.includes("--check")
let stale = 0
for (const sheet of ["raguverse/learn/page/learn.css", "raguverse/world/world.css"]) {
  const path = join(root, sheet)
  const before = readFileSync(path, "utf8")
  const after = withBlock(before, block)
  if (after === before) continue
  stale++
  if (!check) writeFileSync(path, after)
  console.log(`${check ? "out of date" : "written"}: ${sheet}`)
}
if (check && stale) process.exit(1)
