/**
 * The line under the bot's name, in words (D14): «Ragu Code · Grok 4 · gratis · ragionamento alto · solo in questo
 * progetto». What a developer reads («primary», «high», the session id, the full path) is not in it: the path and the
 * session are in the Details of the Settings tab, and `primary`, the ordinary kind of bot, is not said at all.
 */
export function metaWords(input: {
  readonly runner: string
  readonly model: string
  readonly spend: string
  /** Already a phrase («ragionamento alto»), or undefined when the bot has no level set. */
  readonly effort?: string
  /** Only for a subagent: the ordinary bot says nothing. */
  readonly subagent?: string
  readonly scope: string
}): { readonly runner: string; readonly model: string; readonly spend: string; readonly rest: readonly string[] } {
  return {
    runner: input.runner,
    model: input.model,
    spend: input.spend,
    rest: [input.effort, input.subagent, input.scope].filter((part): part is string => Boolean(part)),
  }
}
