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

import { readFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { OUT_FILE, ensureWorld } from "../src/nikverse/city/build-world"

const started = performance.now()
const check = process.argv.includes("--check")
const world = await ensureWorld({ check })
if (!world.ok) {
  console.error(["nikverse world: build failed", ...world.errors].join("\n"))
  process.exit(1)
}
const gz = gzipSync(readFileSync(OUT_FILE)).length
console.log(
  `nikverse world: ${(world.bytes / 1024).toFixed(0)} kB (${(gz / 1024).toFixed(0)} kB gzip) in ${Math.round(performance.now() - started)} ms` +
    (world.written ? ", written" : check ? ", not written" : ", unchanged") +
    `, sha256 ${world.sha256.slice(0, 12)}`,
)
