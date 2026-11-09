/** What `gateway_status` says of a link, as far as the project of its turns goes. */
export interface LinkProject {
  readonly bot: string
  readonly platform: string
  readonly project?: string | null
  /** Switched on. A link that is off keeps its project in the state, but nothing may run in it. */
  readonly enabled?: boolean
  /** False once nothing reads for it; with an error, the link is dead. */
  readonly running?: boolean
  readonly lastError?: string | null
}

/**
 * The platform stopped this link for good (a token revoked, another reader, a webhook): it stays on, nothing reads
 * for it and nothing can be answered. A link starting again is not running for an instant too, with no error (BOT2-2).
 */
export function linkDied(link: LinkProject): boolean {
  return link.enabled !== false && link.running === false && Boolean(link.lastError)
}

/** A status heard from Rust: a dead link's running turn and queue stop, as if it had been switched off (BOT2-2). */
export function stopTurnsOfDeadLink(status: LinkProject, off: (bot: string, platform: string) => void): void {
  if (linkDied(status)) off(status.bot, status.platform)
}

/**
 * The project a chat message of `bot` on `platform` runs in; `undefined` when the link is not there, is switched
 * off or is dead. A message that was already read when «off» was pressed may still reach the page, and the project of a link
 * that is off must not start a turn for it (BOT-2).
 */
export function projectOfLink(links: readonly LinkProject[], bot: string, platform: string): string | undefined {
  const link = links.find((candidate) => candidate.bot === bot && candidate.platform === platform)
  if (!link || link.enabled === false || linkDied(link)) return undefined
  return link.project ?? undefined
}
