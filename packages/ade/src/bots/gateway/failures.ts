/**
 * The last chat turn that failed, per bot and platform, kept in memory for the
 * gateway panel (S10). The chat is told a fixed text; the detail (local paths,
 * the server's words) is here, where the owner looks, and nowhere else. Only
 * the last one, nothing on disk, and the text goes through `scrubSecrets`.
 */

import { scrubSecrets } from "../terms"

export interface TurnFailure {
  readonly at: number
  readonly detail: string
}

const DETAIL_MAX = 600

const last = new Map<string, TurnFailure>()
const listeners = new Set<() => void>()

const keyOf = (bot: string, platform: string) => `${platform}\n${bot}`

/** Keeps `detail` as the last failure of `bot`'s `platform`, and tells whoever watches. */
export function noteTurnFailure(bot: string, platform: string, detail: string, at: number): void {
  const clean = scrubSecrets(detail)
  last.set(keyOf(bot, platform), { at, detail: clean.length > DETAIL_MAX ? `${clean.slice(0, DETAIL_MAX - 1)}…` : clean })
  for (const listener of [...listeners]) listener()
}

export function turnFailureOf(bot: string, platform: string): TurnFailure | undefined {
  return last.get(keyOf(bot, platform))
}

/** Calls `listener` whenever a failure is noted; returns the way to stop. */
export function onTurnFailure(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** For tests. */
export function forgetTurnFailures(): void {
  last.clear()
}
