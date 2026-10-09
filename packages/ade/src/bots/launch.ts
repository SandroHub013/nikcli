import type { AgentFile } from "./ragu"

/*
 * «Terminale» on a bot's card: the same checks as a turn, then the pane (full review 2026-10-06,
 * bots 7). It used to open `ragu --agent <bot>` for a project's bot with no question at all, past
 * both the trust a turn asks for (`trust.ts`) and the refusal of a bot that grants itself the shell,
 * and with the roster's copy of the file, not the one that was trusted. The checks are `admitTurn`'s,
 * handed in; the project's own configuration is not asked about here: the terminal is the user's
 * own ragu, started by them in their folder.
 */
export interface LaunchDeps {
  /** `admitTurn` without a project: a project's bot is asked about, a self-approving one refused. */
  readonly admit: (bot: AgentFile) => Promise<{ ok: true; bot: AgentFile } | { ok: false; problem?: string }>
  /** Opens the pane for the bot as it was trusted. */
  readonly open: (bot: AgentFile) => void
  /** What to say when it is refused for a reason. */
  readonly refused: (bot: AgentFile, problem: string) => void
}

export async function launchBot(bot: AgentFile, deps: LaunchDeps): Promise<boolean> {
  const verdict = await deps.admit(bot)
  if (!verdict.ok) {
    if (verdict.problem) deps.refused(bot, verdict.problem)
    return false
  }
  deps.open(verdict.bot)
  return true
}
