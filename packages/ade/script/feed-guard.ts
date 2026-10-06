#!/usr/bin/env bun
/**
 * Whether `ade-release` may overwrite the updater's feed (`ade-updater/latest.json`).
 *
 *   bun packages/ade/script/feed-guard.ts <current latest.json | -> <version being released>
 *
 * Prints `write` or `skip <why>`; always exits 0 for a well-formed call. A feed that points at an older
 * version than the one installed copies already follow would take their update away until the next
 * release: a `workflow_dispatch` or a rerun of an old tag, or two tags building side by side, wrote the
 * feed with no look at what was in it (full review 2026-10-06, ui 7). The same version is rewritten (a
 * rerun of the newest release); a feed that cannot be read is replaced, since it works for nobody.
 *
 * The rule is in `src/update/feed-guard.ts`; the `publish` job checks out both files.
 */

import { readFileSync } from "node:fs"
import { feedDecision } from "../src/update/feed-guard"

if (import.meta.main) {
  const [file, candidate] = process.argv.slice(2)
  if (!file || !candidate) {
    console.error("usage: feed-guard.ts <current latest.json | -> <version>")
    process.exit(2)
  }
  console.log(feedDecision(file === "-" ? undefined : readFileSync(file, "utf8"), candidate))
}
