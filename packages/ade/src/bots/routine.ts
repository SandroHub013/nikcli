/**
 * The gate one routine execution must pass (B11).
 *
 * Scheduling, the daily counters and the rule for a closed ADE are not here.
 * This only decides whether one execution may start, and starts it through
 * `runTurn`, so the account flag is the same as every other bot spawn.
 */

import { routineModeOf, routinePolicy } from "./terms"
import { applyProblem, emptyTalk } from "./talk"
import { runTurn, type Turn, type TurnDeps, type TurnRequest } from "./turn"

export function runRoutine(request: TurnRequest, deps: TurnDeps = {}): Turn {
  const model = request.model ?? request.bot?.model
  const mode = routineModeOf(request.runner, request.account?.mode, model)
  const policy = routinePolicy(request.runner, mode, model)
  if (!policy.allowed) {
    const talk = applyProblem(emptyTalk(), policy.reason, Date.now())
    return {
      result: Promise.resolve({
        status: "error",
        text: "",
        tokens: 0,
        costUsd: 0,
        problem: policy.reason,
        talk,
      }),
      stop: () => {},
    }
  }
  return runTurn(request, deps)
}
