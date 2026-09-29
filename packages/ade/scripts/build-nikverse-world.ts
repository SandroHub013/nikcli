/**
 * Bundles NikVerse's 3D city into the folder the `nikverse` scheme serves its assets from.
 *
 * `src/nikverse/city/main.ts` (three.js, the WebGPU renderer and the scene) becomes one module,
 * `nikverse-assets/world/city.js`, with nothing loaded from a CDN: the world's policy allows its own
 * host and nothing else. The output is not committed (it is in `.gitignore`); `build.rs` runs this
 * before it lists the folder, so the bundle is hashed into the manifest like every other asset.
 *
 * It writes only when the bytes changed, so a build that changes nothing does not touch the folder
 * and cargo does not rebuild for it.
 *
 * `bun scripts/build-nikverse-world.ts` prints the size; `--check` builds in memory and writes nothing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { OUT_DIR, OUT_FILE, buildWorld } from "../src/nikverse/city/build-world"

const started = performance.now()
const built = await buildWorld()
if (!built.ok) {
  console.error(["nikverse world: build failed", ...built.errors].join("\n"))
  process.exit(1)
}
const bytes = Buffer.byteLength(built.text)
const gz = gzipSync(built.text).length
const same = existsSync(OUT_FILE) && readFileSync(OUT_FILE, "utf8") === built.text
if (!process.argv.includes("--check") && !same) {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, built.text)
}
console.log(
  `nikverse world: ${(bytes / 1024).toFixed(0)} kB (${(gz / 1024).toFixed(0)} kB gzip) in ${Math.round(performance.now() - started)} ms` +
    (same ? ", unchanged" : process.argv.includes("--check") ? ", not written" : ", written"),
)
