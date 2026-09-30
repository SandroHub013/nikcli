/**
 * Bundles NikVerse's 3D city: `city/main.ts` (three.js, the WebGPU renderer and the scene) becomes
 * one module, with nothing loaded from a CDN, because the world's policy allows its own host and
 * nothing else. `scripts/build-nikverse-world.ts` writes it; the tests build it in memory.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

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

/** Which bundle: what a run says it measured or served, so a number is never read against the wrong city. */
export interface WorldBundle {
  sha256: string
  bytes: number
  /** The file's modification time, ISO. */
  modified: string
  /** Whether this call wrote the file (it was missing or different); false when it was already the bundle of the sources. */
  written: boolean
}

/**
 * Makes `city.js` the bundle of the sources as they are now, and says which bundle that is.
 *
 * The file is ignored by git and only a release build or a script rebuilt it, so an ADE Test started by `test:app` (or a gate that found
 * one running) served the city of the last time somebody built it: a branch with the island showed the old city. The bundle costs a
 * quarter of a second, so it is built every time, and written only when the bytes differ (a write that changes nothing would make
 * cargo rebuild for it, see `scripts/build-nikverse-world.ts`). `check` builds and writes nothing.
 */
export async function ensureWorld(
  options: { file?: string; check?: boolean } = {},
): Promise<({ ok: true } & WorldBundle) | { ok: false; errors: string[] }> {
  const file = options.file ?? OUT_FILE
  const built = await buildWorld()
  if (!built.ok) return built
  const same = existsSync(file) && readFileSync(file, "utf8") === built.text
  if (!same && !options.check) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, built.text)
  }
  return {
    ok: true,
    sha256: createHash("sha256").update(built.text).digest("hex"),
    bytes: Buffer.byteLength(built.text),
    modified: existsSync(file) ? statSync(file).mtime.toISOString() : "",
    written: !same && !options.check,
  }
}
