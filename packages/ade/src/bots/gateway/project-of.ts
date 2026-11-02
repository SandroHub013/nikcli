/** What `gateway_status` says of a link, as far as the project of its turns goes. */
export interface LinkProject {
  readonly bot: string
  readonly platform: string
  readonly project?: string | null
  /** Switched on. A link that is off keeps its project in the state, but nothing may run in it. */
  readonly enabled?: boolean
}

/**
 * The project a chat message of `bot` on `platform` runs in; `undefined` when the link is not there or is switched
 * off. A message that was already read when «off» was pressed may still reach the page, and the project of a link
 * that is off must not start a turn for it (BOT-2).
 */
export function projectOfLink(links: readonly LinkProject[], bot: string, platform: string): string | undefined {
  const link = links.find((candidate) => candidate.bot === bot && candidate.platform === platform)
  if (link?.enabled === false) return undefined
  return link?.project ?? undefined
}
