/**
 * The rule behind `script/feed-guard.ts`: whether `ade-release` may overwrite the updater's feed
 * (`ade-updater/latest.json`) with the version it is releasing.
 *
 * Kept here, where the type check and the tests reach it; the script is a thin caller, and the
 * `publish` job checks out only the two files.
 */

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
