/*
 * What a pane is started with (review of review-alti, point 1).
 *
 * ALTO 5 was a bot's `--agent` and `--model`, and a sign-in's subcommand,
 * handed to the first start only: a restart ran the bare agent, on the
 * default model. The fix kept them on the pane (`spawnArgs`, `signIn`), and
 * the only proof that every start reads them was a grep of the workbench.
 * The rules are here now, where a test runs them.
 */
import { agentById } from "../session-new/agents"
import { introArgs, introText } from "../session-new/intro"
import { nativeLaunchArgs } from "../session/native-mail"
import { modelIn } from "../session/orchestra"

/** What of a pane decides how it starts. */
export interface StartingPane {
  /** Chosen at spawn and kept: a bot's flags, `--model`, agy's `--add-dir`. */
  readonly spawnArgs?: readonly string[]
  /** A runner's sign-in: what it runs, every time. */
  readonly signIn?: readonly string[]
}

/**
 * How a pane with no process comes back: a sign-in runs its sign-in again,
 * and resumes nothing, since it has no conversation; anything else is a
 * session, reopened by its plan.
 */
export type Restart = { readonly kind: "signIn"; readonly extra: readonly string[] } | { readonly kind: "session" }

export function restartOf(pane: StartingPane): Restart {
  return pane.signIn?.length ? { kind: "signIn", extra: [...pane.signIn] } : { kind: "session" }
}

/**
 * The arguments of a start, in order: the intro and the title ADE gives the
 * session, the pane's own arguments, the conversation to open, then what
 * this start alone adds. The pane's arguments are read on every start, the
 * first and every restart alike.
 */
export function startArgsFor(
  agentId: string,
  pane: StartingPane | undefined,
  start: { readonly title: string; readonly opening: readonly string[]; readonly extra?: readonly string[] },
): string[] {
  const kept = pane?.spawnArgs ?? []
  const extra = start.extra ?? []
  return [
    // What this CLI always needs, first: Cline's `--tui` (`AgentOption.args`).
    ...(agentById(agentId)?.args ?? []),
    ...introArgs(agentId, introText(agentId, modelIn([...kept, ...extra]))),
    ...nativeLaunchArgs(agentId, start.title),
    ...kept,
    ...start.opening,
    ...extra,
  ]
}
