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
 * Standalone, with no import from `src/`: the `publish` job checks out only what it needs.
 */

import { readFileSync } from "node:fs"

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

function parse(text: unknown): [number, number, number] | undefined {
  if (typeof text !== "string") return undefined
  const match = VERSION.exec(text.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** `write` when the candidate may replace the feed's text, else `skip` and why. */
export function feedDecision(feedText: string | undefined, candidate: string): string {
  const next = parse(candidate)
  if (!next) return `skip the version to release is not x.y.z: ${candidate}`
  if (feedText === undefined) return "write"
  let current: [number, number, number] | undefined
  try {
    current = parse((JSON.parse(feedText) as { version?: unknown }).version)
  } catch {
    current = undefined
  }
  if (!current) return "write"
  for (let i = 0; i < 3; i++) {
    if (current[i]! > next[i]!) return `skip the feed is at ${current.join(".")}, newer than ${candidate}`
    if (current[i]! < next[i]!) return "write"
  }
  return "write"
}

if (import.meta.main) {
  const [file, candidate] = process.argv.slice(2)
  if (!file || !candidate) {
    console.error("usage: feed-guard.ts <current latest.json | -> <version>")
    process.exit(2)
  }
  console.log(feedDecision(file === "-" ? undefined : readFileSync(file, "utf8"), candidate))
}
