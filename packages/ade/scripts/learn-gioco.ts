/**
 * The conversion of the injection game levels, run when a YAML changes: `bun run scripts/learn-gioco.ts`.
 *
 * It writes `src/nikverse/learn/gioco.json`, which the lesson page loads when playing «Trova l'iniezione».
 */
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { convertGioco, giocoFiles, toGiocoJson } from "../src/nikverse/learn/gioco-build"

const root = resolve(import.meta.dirname, "../src/nikverse/learn")
const giocoDir = root + "/gioco"
const target = `${root}/gioco.json`

try {
  const files = giocoFiles(giocoDir)
  const content = convertGioco(giocoDir)
  writeFileSync(target, toGiocoJson(content))
  console.log(`gioco.json: ${files.length} livelli, da ${files[0] ?? "-"} a ${files.at(-1) ?? "-"}`)
} catch (error) {
  console.error(`learn-gioco: ${(error as Error).message}`)
  process.exit(1)
}
