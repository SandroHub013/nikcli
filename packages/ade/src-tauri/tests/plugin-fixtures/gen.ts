/**
 * Makes the fixtures of `src/plugin_install.rs`'s tests: the two manifests, and the signed indexes. Run once, and again when a fixture
 * changes; what it writes is committed. The PRIVATE keys are not: they live wherever `PLUGIN_TEST_KEYS` says (a folder with `test.key`
 * and `other.key`, made with `tauri signer generate --ci -p "" -w <file>`), and only their public halves are in the repo
 * (`test.pub`, `other.pub`). These keys sign nothing but these files: a test checks that the public one is not a release's key.
 *
 *   PLUGIN_TEST_KEYS=<folder> bun tests/plugin-fixtures/gen.ts   (from packages/ade/src-tauri)
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const here = import.meta.dir
const keys = process.env.PLUGIN_TEST_KEYS
if (!keys) throw new Error("PLUGIN_TEST_KEYS names the folder with test.key and other.key")
const tauri = join(here, "..", "..", "..", "node_modules", ".bin", "tauri.exe")

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** `{path, sha256, size}` of every file of a folder, sorted, forward slashes. */
function listed(dir: string, prefix = ""): { path: string; sha256: string; size: number }[] {
  const out: { path: string; sha256: string; size: number }[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listed(full, `${prefix}${name}/`))
    else out.push({ path: `${prefix}${name}`, sha256: sha(readFileSync(full)), size: statSync(full).size })
  }
  return out
}

function manifest(version: string, permissions: string[]) {
  const text = JSON.stringify({ id: "nikverse", version, permissions, files: listed(join(here, `nikverse-${version}`)) }, null, 2) + "\n"
  writeFileSync(join(here, `manifest-${version}.json`), text)
  return sha(Buffer.from(text))
}

const m100 = manifest("1.0.0", ["theme", "snapshot"])
const m110 = manifest("1.1.0", ["theme", "snapshot", "chords"])

/** An index and the signature of it, by `key`. */
function index(name: string, body: object, key = "test.key") {
  const file = join(here, `${name}.json`)
  writeFileSync(file, JSON.stringify(body, null, 2) + "\n")
  const signed = spawnSync(tauri, ["signer", "sign", "-f", join(keys, key), "-p", "", file], { encoding: "utf8" })
  if (signed.status !== 0) throw new Error(`signing ${name}: ${signed.stderr}${signed.stdout}`)
}

const entry = (version: string, manifestHash: string, extra: object = {}) => ({
  nikverse: { version, api: 1, min_ade: "0.0.0", manifest: manifestHash, ...extra },
})

index("index-good", { issued_at: 1000, plugins: entry("1.0.0", m100) })
index("index-update", { issued_at: 2000, plugins: entry("1.1.0", m110) })
// Older than the last one accepted (good is 1000).
index("index-old", { issued_at: 900, plugins: entry("1.0.0", m100) })
// A version under the installed one (1.0.0), with a newer issue date.
index("index-downgrade", { issued_at: 3000, plugins: entry("0.9.0", m100) })
index("index-api2", { issued_at: 3000, plugins: entry("1.2.0", m110, { api: 2 }) })
index("index-api0", { issued_at: 3000, plugins: entry("1.2.0", m110, { api: 0 }) })
index("index-minade", { issued_at: 3000, plugins: entry("1.2.0", m110, { min_ade: "99.0.0" }) })
// Good's content, signed by another key: the signature is valid, and not ours.
index("index-otherkey", { issued_at: 1000, plugins: entry("1.0.0", m100) }, "other.key")
// Good's signature over other bytes: an index changed after it was signed.
const good = readFileSync(join(here, "index-good.json"), "utf8")
writeFileSync(join(here, "index-tampered.json"), good.replace('"issued_at": 1000', '"issued_at": 1001'))
console.log("manifest 1.0.0", m100)
console.log("manifest 1.1.0", m110)
