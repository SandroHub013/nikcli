/**
 * Bundles NikVerse's 3D city: `city/main.ts` (three.js, the WebGPU renderer and the scene) becomes
 * one module, with nothing loaded from a CDN, because the world's policy allows its own host and
 * nothing else. `scripts/build-nikverse-world.ts` writes it; the tests build it in memory.
 */

import { join } from "node:path"

const root = join(import.meta.dir, "..", "..", "..")
/** Where the bundle is written: the assets folder the `nikverse` scheme serves, under `world/`. */
export const OUT_DIR = join(root, "src-tauri", "nikverse-assets", "world")
export const OUT_FILE = join(OUT_DIR, "city.js")
export const ENTRY = join(root, "src", "nikverse", "city", "main.ts")

/** Builds the bundle in memory: its text, or the reasons it failed. */
export async function buildWorld(): Promise<{ ok: true; text: string } | { ok: false; errors: string[] }> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: "browser",
    format: "esm",
    minify: true,
    splitting: false,
    sourcemap: "none",
    naming: "city.js",
  })
  if (!result.success) return { ok: false, errors: result.logs.map((log) => String(log)) }
  return { ok: true, text: await result.outputs[0].text() }
}
