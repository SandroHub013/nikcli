/**
 * The line under the bot's name, in words (D14): «Ragu Code · Grok 4 · gratis · ragionamento alto · solo in questo
 * progetto». What a developer reads («primary», «high», the session id, the full path) is not in it: the path and the
 * session are in the Details of the Settings tab, and `primary`, the ordinary kind of bot, is not said at all.
 */
/**
 * The new-bot form's line under what it is for (design/ade-bot-2, scelta 1): what the closed «Avanzate» holds, in
 * words. «Ragu Code · modello predefinito · tetto 1 $ al giorno · nel progetto»; the cap only when one is asked.
 */
export function newBotSummary(input: {
  readonly runner: string
  readonly model: string
  readonly cap?: string
  readonly where: string
}): string {
  return [input.runner, input.model, input.cap, input.where].filter((part): part is string => Boolean(part)).join(" · ")
}

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
